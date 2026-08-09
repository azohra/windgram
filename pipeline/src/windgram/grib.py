"""Point sampling from GRIB2 messages via ecCodes, plus the rotated-grid
helpers the ensemble build needs.

The HRDPS 1 km West grid is a rotated lat-lon; ecCodes' nearest-neighbour
lookup handles the rotation, so callers only ever speak geographic
coordinates. That lookup has no fast path on rotated grids — it scans all
1.6M points per call — and every message in a run shares one grid, so the
resolved grid index (with its distance, for the out-of-domain guard) is
cached per (grid, point) and later messages are a direct element read.

Datamart fields are JPEG2000-packed (`grid_jpeg`), and ecCodes decodes the
whole field internally on *every* element read — codes_get_double_element
costs the same as decoding all 3.3M points (~0.2 s on an HRDPS field). A
message's values are therefore decoded once, lazily, on the first point
access and served from the cached array for the message's lifetime; the
array (~26 MB for HRDPS) is dropped with the message, so peak residency
stays one decoded field per in-flight message.
"""

from __future__ import annotations

import math
import threading

import eccodes

_index_cache: dict[tuple, tuple[int, float]] = {}
_index_lock = threading.Lock()


def split_messages(buffer: bytes) -> list[bytes]:
    """Splits a GRIB2 file of concatenated messages (e.g. an all-members
    ensemble file) into single messages, using each message's declared total
    length. Fails loudly on misaligned or truncated bytes rather than
    guessing — a garbled download must not become a silent member gap."""
    messages = []
    offset = 0
    while offset < len(buffer):
        if buffer[offset : offset + 4] != b"GRIB":
            raise ValueError(f"GRIB stream is misaligned at byte {offset}")
        length = int.from_bytes(buffer[offset + 8 : offset + 16], "big")
        end = offset + length
        if length < 20 or end > len(buffer) or buffer[end - 4 : end] != b"7777":
            raise ValueError(f"GRIB message at byte {offset} is truncated")
        messages.append(buffer[offset:end])
        offset = end
    return messages


def earth_wind(
    u_grid_ms: float,
    v_grid_ms: float,
    latitude: float,
    longitude: float,
    south_pole_latitude: float,
    south_pole_longitude: float,
) -> tuple[float, float]:
    """True east/north wind components from grid-relative components on a
    rotated lat-lon grid (GRIB uvRelativeToGrid=1, angle of rotation 0).

    The rotated frame is the geographic frame turned by Rz(south pole
    longitude) then Ry(90° + south pole latitude) — the convention that maps
    the grid's rotated coordinates onto ecCodes' geolocation of the REPS grid
    (verified against its latitudes/longitudes arrays to ~1e-6°). The wind is
    treated as the 3-D tangent vector it is: composed on the rotated basis,
    expressed in the geographic frame, and projected onto true east/north.
    """
    z_angle = math.radians(south_pole_longitude)
    y_angle = math.radians(90.0 + south_pole_latitude)

    def to_rotated(v: tuple[float, float, float]) -> tuple[float, float, float]:
        x = v[0] * math.cos(z_angle) + v[1] * math.sin(z_angle)
        y = -v[0] * math.sin(z_angle) + v[1] * math.cos(z_angle)
        return (
            x * math.cos(y_angle) + v[2] * math.sin(y_angle),
            y,
            -x * math.sin(y_angle) + v[2] * math.cos(y_angle),
        )

    def to_geographic(v: tuple[float, float, float]) -> tuple[float, float, float]:
        x = v[0] * math.cos(y_angle) - v[2] * math.sin(y_angle)
        z = v[0] * math.sin(y_angle) + v[2] * math.cos(y_angle)
        return (
            x * math.cos(z_angle) - v[1] * math.sin(z_angle),
            x * math.sin(z_angle) + v[1] * math.cos(z_angle),
            z,
        )

    def east_north(lat_rad: float, lon_rad: float):
        east = (-math.sin(lon_rad), math.cos(lon_rad), 0.0)
        north = (
            -math.sin(lat_rad) * math.cos(lon_rad),
            -math.sin(lat_rad) * math.sin(lon_rad),
            math.cos(lat_rad),
        )
        return east, north

    lat_rad, lon_rad = math.radians(latitude), math.radians(longitude)
    point = (
        math.cos(lat_rad) * math.cos(lon_rad),
        math.cos(lat_rad) * math.sin(lon_rad),
        math.sin(lat_rad),
    )
    rotated_point = to_rotated(point)
    rotated_lat = math.asin(max(-1.0, min(1.0, rotated_point[2])))
    rotated_lon = math.atan2(rotated_point[1], rotated_point[0])

    grid_east, grid_north = east_north(rotated_lat, rotated_lon)
    wind = tuple(
        u_grid_ms * grid_east[axis] + v_grid_ms * grid_north[axis] for axis in range(3)
    )
    wind_geo = to_geographic(wind)
    true_east, true_north = east_north(lat_rad, lon_rad)
    return (
        sum(wind_geo[axis] * true_east[axis] for axis in range(3)),
        sum(wind_geo[axis] * true_north[axis] for axis in range(3)),
    )


class GribField:
    def __init__(self, message: bytes):
        self._gid = eccodes.codes_new_from_message(message)
        self._missing = eccodes.codes_get(self._gid, "missingValue")
        self._grid_key = eccodes.codes_get(self._gid, "md5GridSection")
        self._values = None  # decoded once, on first point access

    def metadata(self, key: str):
        return eccodes.codes_get(self._gid, key)

    def value_at(
        self, latitude: float, longitude: float, max_distance_km: float | None = None
    ) -> float | None:
        """The nearest gridpoint's value, or None where the field is missing.

        ecCodes clamps out-of-domain points to the boundary of large grids
        (reporting a huge distance) and raises outright on small ones, so a
        distance cap is what tells "nearest gridpoint" apart from "point is
        outside the model's domain"."""
        key = (self._grid_key, latitude, longitude)
        with _index_lock:
            nearest = _index_cache.get(key)
        if nearest is None:
            try:
                found = eccodes.codes_grib_find_nearest(self._gid, latitude, longitude)[0]
            except eccodes.OutOfAreaError:
                raise RuntimeError(
                    f"({latitude}, {longitude}) is outside the model grid"
                ) from None
            nearest = (int(found.index), float(found.distance))
            with _index_lock:
                _index_cache[key] = nearest
        index, distance_km = nearest
        if max_distance_km is not None and distance_km > max_distance_km:
            raise RuntimeError(
                f"({latitude}, {longitude}) is outside the model grid "
                f"(nearest gridpoint {distance_km:.0f} km away)"
            )
        # Decode the whole field once: on JPEG2000-packed Datamart fields
        # every per-element read costs a full-field decode, so per-site
        # element extraction would re-decode the same field site × times.
        if self._values is None:
            self._values = eccodes.codes_get_values(self._gid)
        value = float(self._values[index])
        if value == self._missing:
            return None
        return value

    def close(self) -> None:
        self._values = None
        eccodes.codes_release(self._gid)

    def __enter__(self) -> "GribField":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()
