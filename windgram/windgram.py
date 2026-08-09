"""Derives windgram profiles — the published JSON consumers store and
render — from model source hours. The derivations (boundary-layer depth,
thermal velocity, cloud base, usable-lift top) were held constant through
the schema migration as its verification oracle; they evolve from that
baseline as richer model data justifies it. The published contract owns
the envelope around them — nested surface/levels/derived blocks, SI units,
dew point instead of depression, every forecast hour published, no
smoothing.

Dict key order is deliberate: it matches the published contract so
published files diff cleanly.
"""

from __future__ import annotations

import math

SCHEMA_VERSION = 1
WINDGRAM_PRESSURE_LEVELS = (925, 900, 875, 850, 800, 750, 700, 650, 600)

_DRY_ADIABATIC_LAPSE_C_PER_M = 0.0098
_SINK_RATE_MS = 1.0

# A level counts as saturated when its dew-point depression is at or below
# this — the same 0.5 °C the renderer uses for its dense-cloud hatch class,
# so the published cloud base never sits above a layer the chart hatches.
_SATURATED_DEPRESSION_C = 0.5


def derive_windgram_profile(source: dict, model: str) -> dict:
    """model is the slug — the model's data/ directory name."""
    return {
        "schemaVersion": SCHEMA_VERSION,
        "model": model,
        "run": {
            "referenceTime": source["referenceTime"],
            "generatedAt": source["generatedAt"],
        },
        "site": {
            "id": source["siteId"],
            "name": source["siteName"],
            "latitude": source["latitude"],
            "longitude": source["longitude"],
            "altitudeM": source["siteAltitudeM"],
            "modelElevationM": source["modelElevationM"],
        },
        "hours": [_derive_hour(hour, source["modelElevationM"]) for hour in source["hours"]],
    }


def _derive_hour(source: dict, model_elevation_m: float) -> dict:
    levels = sorted(
        (
            level
            for level in source["levels"]
            if math.isfinite(level["heightM"]) and level["heightM"] > model_elevation_m + 20
        ),
        key=lambda level: level["heightM"],
    )

    cloud_base_m = _cloud_base_m(
        source["temperatureC"], source["dewPointDepressionC"], model_elevation_m, levels
    )
    boundary_layer_depth_m = _boundary_layer_depth(
        source["temperatureC"], model_elevation_m, levels
    )
    thermal_velocity_ms = _thermal_velocity(
        source["temperatureC"],
        source["sensibleHeatFluxWm2"],
        source["latentHeatFluxWm2"],
        boundary_layer_depth_m,
        levels[0]["pressureHpa"] if levels else None,
    )
    usable_lift_top_m = _usable_lift_top(
        model_elevation_m,
        cloud_base_m,
        boundary_layer_depth_m,
        thermal_velocity_ms,
        levels,
    )

    surface = {
        "pressurePa": source["pressurePa"],
        "temperatureC": source["temperatureC"],
        "dewPointC": source["temperatureC"] - source["dewPointDepressionC"],
        "windSpeedMs": max(0.0, source["windSpeedMs"]),
        "windDirectionDeg": _normalize_degrees(source["windDirectionDeg"]),
        "cloudCoverPercent": _clamp(source["cloudCoverPercent"], 0.0, 100.0),
        "precipitationMmHr": max(0.0, source["precipitationMm"]),
        "sensibleHeatFluxWm2": source["sensibleHeatFluxWm2"],
        "latentHeatFluxWm2": source["latentHeatFluxWm2"],
    }
    # Optional science fields (contract order): present only when the builder
    # fetched them — a masked ECCC sentinel or an uncapable model publishes
    # nothing, never a placeholder.
    for field_name, sanitize in _OPTIONAL_SURFACE_FIELDS:
        if field_name in source:
            surface[field_name] = sanitize(source[field_name])

    return {
        "validAt": source["validAt"],
        "surface": surface,
        "levels": [_derive_level(level) for level in levels],
        "derived": {
            "boundaryLayerTopM": (
                model_elevation_m + boundary_layer_depth_m
                if boundary_layer_depth_m > 0
                else None
            ),
            "thermalVelocityMs": thermal_velocity_ms,
            "cloudBaseM": cloud_base_m,
            "usableLiftTopM": usable_lift_top_m,
        },
    }


# Sanitizers for the optional surface fields, in published (contract) order.
# Gust, CAPE, and PBL depth are non-negative by definition; CIN is <= 0 by
# definition; cloud-layer fractions are percentages.
_OPTIONAL_SURFACE_FIELDS = (
    ("windGustMs", lambda v: max(0.0, v)),
    ("capeJkg", lambda v: max(0.0, v)),
    ("cinJkg", lambda v: min(0.0, v)),
    ("pblHeightM", lambda v: max(0.0, v)),
    ("lowCloudPercent", lambda v: _clamp(v, 0.0, 100.0)),
    ("midCloudPercent", lambda v: _clamp(v, 0.0, 100.0)),
    ("highCloudPercent", lambda v: _clamp(v, 0.0, 100.0)),
)


def _derive_level(level: dict) -> dict:
    derived = {
        "pressureHpa": level["pressureHpa"],
        "heightM": level["heightM"],
        "temperatureC": level["temperatureC"],
        "dewPointC": level["temperatureC"] - level["dewPointDepressionC"],
        "windSpeedMs": max(0.0, level["windSpeedMs"]),
        "windDirectionDeg": _normalize_degrees(level["windDirectionDeg"]),
    }
    # Omega is level-sparse: a model publishes it on a few pressure levels
    # (GRIB transports only), and the contract's Level field is optional per
    # level.
    if "verticalVelocityPaS" in level:
        derived["verticalVelocityPaS"] = level["verticalVelocityPaS"]
    # Per-level cloud fraction is model-sparse (GFS only today).
    if "cloudFractionPercent" in level:
        derived["cloudFractionPercent"] = _clamp(level["cloudFractionPercent"], 0.0, 100.0)
    return derived


def _cloud_base_m(
    surface_temperature_c: float,
    dew_point_depression_c: float,
    model_elevation_m: float,
    levels: list[dict],
) -> float:
    """Effective cloud base: the surface parcel's condensation level, pulled
    down to any level where the model's own moisture column already
    saturates below it. The parcel LCL answers "where would lifted surface
    air condense"; the column scan answers "where does the model already put
    cloud" — the lower of the two is where a climb meets cloud."""
    cloud_base_m = model_elevation_m + _parcel_lcl_agl_m(
        surface_temperature_c, surface_temperature_c - dew_point_depression_c
    )
    first_saturated_m = _first_saturated_altitude_m(
        dew_point_depression_c, model_elevation_m, levels
    )
    if first_saturated_m is not None:
        cloud_base_m = min(cloud_base_m, first_saturated_m)
    return _clamp_altitude(cloud_base_m, model_elevation_m)


def _parcel_lcl_agl_m(temperature_c: float, dew_point_c: float) -> float:
    """Height above the surface at which a lifted parcel condenses.

    Bolton (1980, Mon. Wea. Rev. 108, 1046-1053, eq. 15) gives the LCL
    temperature explicitly from temperature and dew point, accurate to
    0.1 K over the meteorological range:

        T_LCL = 1 / (1/(T_d - 56) + ln(T/T_d)/800) + 56      [K]

    Romps (2017, J. Atmos. Sci. 74, 3891-3900) has the exact closed form,
    but it needs the Lambert W function — an extra dependency or an
    iterative evaluation. Checked against Romps over -20..+35 degC dew
    points, this stays within about 1% (tens of metres), most of that the
    shared dry-lapse constant rather than Bolton's fit. The condensation
    height is the dry-adiabatic ascent that cools the parcel from T to
    T_LCL. A parcel at or past saturation condenses at the surface: zero.
    """
    if dew_point_c >= temperature_c:
        return 0.0
    temperature_k = temperature_c + 273.15
    dew_point_k = dew_point_c + 273.15
    lcl_temperature_k = (
        1.0 / (1.0 / (dew_point_k - 56.0) + math.log(temperature_k / dew_point_k) / 800.0)
        + 56.0
    )
    return max(0.0, (temperature_k - lcl_temperature_k) / _DRY_ADIABATIC_LAPSE_C_PER_M)


def _first_saturated_altitude_m(
    surface_dew_point_depression_c: float, model_elevation_m: float, levels: list[dict]
) -> float | None:
    """Lowest altitude (MSL) where the published column itself saturates —
    dew-point depression down at the hatch threshold — interpolated between
    the bracketing samples; None when the whole column stays drier."""
    profile = [(model_elevation_m, surface_dew_point_depression_c)] + [
        (level["heightM"], level["dewPointDepressionC"]) for level in levels
    ]
    profile = [(altitude, depression) for altitude, depression in profile if math.isfinite(depression)]
    if not profile:
        return None
    if profile[0][1] <= _SATURATED_DEPRESSION_C:
        return profile[0][0]
    for (below_m, below_c), (above_m, above_c) in zip(profile, profile[1:]):
        if above_c <= _SATURATED_DEPRESSION_C:
            fraction = (below_c - _SATURATED_DEPRESSION_C) / (below_c - above_c)
            return below_m + fraction * (above_m - below_m)
    return None


def _boundary_layer_depth(
    surface_temperature_c: float, model_elevation_m: float, levels: list[dict]
) -> float:
    for index, level in enumerate(levels):
        altitude_agl_m = level["heightM"] - model_elevation_m
        lifted_parcel_temperature_c = (
            surface_temperature_c - altitude_agl_m * _DRY_ADIABATIC_LAPSE_C_PER_M
        )
        if lifted_parcel_temperature_c > level["temperatureC"]:
            continue

        if index == 0:
            return max(0.0, altitude_agl_m)
        previous = levels[index - 1]
        previous_agl_m = previous["heightM"] - model_elevation_m
        lapse = (level["temperatureC"] - previous["temperatureC"]) / (
            level["heightM"] - previous["heightM"]
        )
        denominator = _DRY_ADIABATIC_LAPSE_C_PER_M + lapse
        if abs(denominator) < 0.00001:
            return max(0.0, previous_agl_m)
        return max(
            0.0,
            (surface_temperature_c - previous["temperatureC"] + lapse * previous_agl_m)
            / denominator,
        )

    if levels:
        return max(0.0, levels[-1]["heightM"] - model_elevation_m)
    return 0.0


def _thermal_velocity(
    surface_temperature_c: float,
    sensible_heat_flux_wm2: float,
    latent_heat_flux_wm2: float,
    boundary_layer_depth_m: float,
    first_pressure_hpa: float | None,
) -> float:
    if boundary_layer_depth_m <= 0 or first_pressure_hpa is None:
        return 0.0
    surface_temperature_k = surface_temperature_c + 273.15
    virtual_heat_flux = (
        sensible_heat_flux_wm2 + 0.000245268 * surface_temperature_k * latent_heat_flux_wm2
    )
    if virtual_heat_flux <= 0:
        return 0.0

    potential_temperature_k = surface_temperature_k * (1015 / first_pressure_hpa) ** 0.28482
    return math.cbrt(
        (0.0075516 / potential_temperature_k) * virtual_heat_flux * boundary_layer_depth_m
    )


def _usable_lift_top(
    model_elevation_m: float,
    cloud_base_m: float,
    boundary_layer_depth_m: float,
    thermal_velocity_ms: float,
    levels: list[dict],
) -> float | None:
    # canadarasp's hcrit, ported constant-for-constant: the height where the
    # STRONGEST core still out-climbs the sink rate. The 4 is Lenschow &
    # Stephens' average-updraft coefficient (1.34) times ~3 for the core, per
    # canadarasp's own derivation — which is why this line can legitimately sit
    # above the boundary layer: cores overshoot the mixed-layer top before they
    # die. The formula is canadarasp's hcrit, ported faithfully as the
    # refactor's verification oracle.
    if boundary_layer_depth_m <= 0 or thermal_velocity_ms * 2.02 < _SINK_RATE_MS:
        return None

    previous_altitude_agl_m = boundary_layer_depth_m * 0.2
    previous_updraft_ms = thermal_velocity_ms * 1.97

    for level in levels:
        altitude_agl_m = level["heightM"] - model_elevation_m
        if altitude_agl_m < boundary_layer_depth_m * 0.25:
            continue
        if level["heightM"] >= cloud_base_m:
            return cloud_base_m

        normalized_height = altitude_agl_m / boundary_layer_depth_m
        updraft_ms = (
            thermal_velocity_ms
            * 4
            * math.cbrt(max(0.0, normalized_height))
            * (1 - 0.8 * normalized_height)
        )
        if updraft_ms <= _SINK_RATE_MS:
            fraction = _clamp(
                (_SINK_RATE_MS - previous_updraft_ms) / (updraft_ms - previous_updraft_ms),
                0.0,
                1.0,
            )
            return min(
                cloud_base_m,
                model_elevation_m
                + previous_altitude_agl_m
                + fraction * (altitude_agl_m - previous_altitude_agl_m),
            )
        previous_altitude_agl_m = altitude_agl_m
        previous_updraft_ms = updraft_ms

    return min(cloud_base_m, model_elevation_m + boundary_layer_depth_m)


def _clamp_altitude(value: float, minimum: float) -> float:
    return max(minimum, value) if math.isfinite(value) else minimum


def _clamp(value: float, minimum: float, maximum: float) -> float:
    return min(maximum, max(minimum, value))


def _normalize_degrees(degrees: float) -> float:
    return ((degrees % 360) + 360) % 360
