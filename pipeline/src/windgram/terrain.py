"""One-shot terrain and land-cover context for the site catalogue.

`windgram terrain` reads sites.json and writes site-context.json — the
static "what is this launch, physically?" document the contract defines
beside the hand-maintained catalogues. No cadence and no manifest: it is
catalogue enrichment, regenerated when the catalogue changes and
committed to git, never a dataset build.

Three open, anonymous COG endpoints, all access recipes proven by the
live probe [verified 2026-08-10, streamed windows via rasterio /vsicurl/]:

- **Copernicus GLO-30** (30 m DSM, EPSG:4326, EGM2008) is the terrain
  analysis source — one consistent model across every site, so slope,
  aspect and relief compare across the catalogue. Point elevations
  agreed with the surveyed launches within ±7 m at the founding sites.
- **LidarBC 1 m DTM**, discovered through the province's tile-index
  FeatureServer, is the preferred bare-earth elevation; **MRDEM-30 DTM**
  (national single COG) is the fallback. Both nodata → the `bareEarth`
  block is omitted: absence means "not measured", never agreement.
  HRDEM is deliberately not used — the probe proved its mosaic covers
  only one catalogued site, which LidarBC also covers (agreement 5 cm).
- **ESA WorldCover 2021 v200** (10 m classes, EPSG:4326) supplies the
  launch-point class and disc composition.

GLO-30 and WorldCover are wall-to-wall over land, so nodata from either
is a coordinate mistake, not a data gap — the run fails loudly. rasterio
and numpy live behind the `terrain` optional extra so the cron builds
stay lean; rasterio is imported lazily inside the command.
"""

from __future__ import annotations

import math
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy
import requests

from .publish import round_document, write_json

SCHEMA_VERSION = 1

# Relief and composition discs, ascending radius — the contract publishes
# radiusKm, so these stay whole kilometres.
RELIEF_RADII_M = (1_000, 3_000, 10_000)
LAND_COVER_RADII_M = (1_000, 3_000)

# Local equirectangular degree→metre scales, error <0.3 % over ≤10 km at
# the catalogue's latitudes [verified 2026-08-10, probe cross-check].
M_PER_DEG_LAT = 111_132.0

# A terrain elevation this far from the surveyed one is far outside the
# DEM's demonstrated ±7 m — almost certainly a catalogued coordinate
# mistake, so the run warns (the surveyed value may be the stale one).
SURVEY_DISAGREEMENT_WARN_M = 100.0

REQUEST_TIMEOUT_S = 60

GLO30_ID = "glo30"
LIDARBC_ID = "lidarbc"
MRDEM30_ID = "mrdem30"
WORLDCOVER_ID = "worldcover2021"

# Every source the generator can reference, in publication order. The
# attribution strings are the statements each licence requires to travel
# with the data — the document carries them so renderers can comply.
SOURCES = {
    GLO30_ID: {
        "id": GLO30_ID,
        "product": "Copernicus GLO-30 DEM",
        "kind": "surfaceModel",
        "resolutionM": 30,
        "licence": "Copernicus DEM licence",
        "attribution": (
            "produced using Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and "
            "© Airbus Defence and Space GmbH 2014-2018 provided under "
            "COPERNICUS by the European Union and ESA; all rights reserved"
        ),
        "url": "https://registry.opendata.aws/copernicus-dem/",
    },
    LIDARBC_ID: {
        "id": LIDARBC_ID,
        "product": "LidarBC 1 m bare-earth DEM",
        "kind": "bareEarthModel",
        "resolutionM": 1,
        "licence": "OGL-BC",
        "attribution": (
            "Contains information licensed under the Open Government Licence"
            " – British Columbia."
        ),
        "url": "https://lidar.gov.bc.ca",
    },
    MRDEM30_ID: {
        "id": MRDEM30_ID,
        "product": "NRCan MRDEM 30 m DTM (CanElevation)",
        "kind": "bareEarthModel",
        "resolutionM": 30,
        "licence": "OGL-Canada",
        "attribution": (
            "Contains information licensed under the Open Government Licence"
            " – Canada."
        ),
        "url": "https://registry.opendata.aws/canelevation-dem/",
    },
    WORLDCOVER_ID: {
        "id": WORLDCOVER_ID,
        "product": "ESA WorldCover 10 m 2021 v200",
        "kind": "landCover",
        "resolutionM": 10,
        "licence": "CC-BY 4.0",
        "attribution": (
            "© ESA WorldCover project 2021 / Contains modified Copernicus "
            "Sentinel data (2021) processed by ESA WorldCover consortium"
        ),
        "url": "https://zenodo.org/records/7254221",
    },
}

# WorldCover v200 class codes → the contract's semantic names. A code
# outside this table is a taxonomy change upstream and must fail the run,
# never be guessed at.
LAND_COVER_CLASSES = {
    10: "treeCover",
    20: "shrubland",
    30: "grassland",
    40: "cropland",
    50: "builtUp",
    60: "bareSparse",
    70: "snowIce",
    80: "water",
    90: "wetland",
    95: "mangroves",
    100: "mossLichen",
}

MRDEM30_URL = (
    "https://canelevation-dem.s3.ca-central-1.amazonaws.com/mrdem-30/mrdem-30-dtm.tif"
)
LIDARBC_QUERY_URL = (
    "https://services6.arcgis.com/ubm4tcTYICKBpist/arcgis/rest/services/"
    "LiDAR_BC_S3_Public/FeatureServer/6/query"
)


# --------------------------------------------------------------- tile keys


def _hemisphere(degrees: int, positive: str, negative: str, width: int) -> str:
    prefix = positive if degrees >= 0 else negative
    return f"{prefix}{abs(degrees):0{width}d}"


def glo30_url(latitude: float, longitude: float) -> str:
    """The GLO-30 COG covering a point: 1°×1° tiles named by their SW
    corner, so both axes floor — a west longitude of −117.18 lands in
    W118, exactly −117.0 in W117 [verified 2026-08-10, bucket listing]."""
    stem = (
        "Copernicus_DSM_COG_10_"
        f"{_hemisphere(math.floor(latitude), 'N', 'S', 2)}_00_"
        f"{_hemisphere(math.floor(longitude), 'E', 'W', 3)}_00_DEM"
    )
    return (
        f"https://copernicus-dem-30m.s3.eu-central-1.amazonaws.com/{stem}/{stem}.tif"
    )


def worldcover_url(latitude: float, longitude: float) -> str:
    """The WorldCover 2021 v200 COG covering a point: 3°×3° tiles named
    by their SW corner [verified 2026-08-10, bucket listing]."""
    stem = (
        "ESA_WorldCover_10m_2021_v200_"
        f"{_hemisphere(3 * math.floor(latitude / 3), 'N', 'S', 2)}"
        f"{_hemisphere(3 * math.floor(longitude / 3), 'E', 'W', 3)}_Map"
    )
    return f"https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/{stem}.tif"


# --------------------------------------------------------------- pure math


def m_per_deg_lon(latitude: float) -> float:
    return 111_320.0 * math.cos(math.radians(latitude))


def bilinear(arr, lats, lons, latitude: float, longitude: float) -> float | None:
    """Bilinear interpolation at a point from a window with pixel-centre
    coordinate vectors (lats north→south, lons west→east — the formula is
    sign-agnostic). None when any contributing pixel is nodata."""
    fx = (longitude - lons[0]) / (lons[1] - lons[0])
    fy = (latitude - lats[0]) / (lats[1] - lats[0])
    x0, y0 = math.floor(fx), math.floor(fy)
    quad = arr[y0 : y0 + 2, x0 : x0 + 2]
    if quad.shape != (2, 2):
        return None
    if numpy.ma.isMaskedArray(quad) and quad.mask.any():
        return None
    quad = numpy.ma.filled(quad.astype(numpy.float64), numpy.nan)
    tx, ty = fx - x0, fy - y0
    return float(
        quad[0, 0] * (1 - tx) * (1 - ty)
        + quad[0, 1] * tx * (1 - ty)
        + quad[1, 0] * (1 - tx) * ty
        + quad[1, 1] * tx * ty
    )


def horn_slope_aspect(z, xres_m: float, yres_m: float) -> tuple[float, float]:
    """Horn (1981) 3×3 slope and aspect from a north-up neighbourhood
    (row 0 north, column 0 west) with metre spacings. Aspect is the
    compass bearing of the downslope direction, 0–360°; on a flat plane
    the gradient vanishes and it degenerates to 0 (slope 0 says so)."""
    (a, b, c), (d, _, f), (g, h, i) = numpy.asarray(z, dtype=numpy.float64)
    east = ((c + 2 * f + i) - (a + 2 * d + g)) / (8 * xres_m)
    north = ((a + 2 * b + c) - (g + 2 * h + i)) / (8 * yres_m)
    slope = math.degrees(math.atan(math.hypot(east, north)))
    aspect = (math.degrees(math.atan2(-east, -north)) + 360.0) % 360.0
    return slope, aspect


def disc_mask(lats, lons, latitude: float, longitude: float, radius_m: float):
    """Pixels whose CENTRE lies within the radius, distances via the
    local equirectangular scaling at the site latitude."""
    dx = (numpy.asarray(lons)[None, :] - longitude) * m_per_deg_lon(latitude)
    dy = (numpy.asarray(lats)[:, None] - latitude) * M_PER_DEG_LAT
    return dx * dx + dy * dy <= radius_m * radius_m


def disc_is_covered(lats, lons, latitude: float, longitude: float, radius_m: float) -> bool:
    """Whether the window's pixel-centre extent holds every pixel the
    disc could claim: the nearest pixel centre OUTSIDE the window on each
    side must already lie beyond the radius. Windows are clamped to their
    tile, so a clamped edge inside a disc means truncated statistics —
    the plausible-but-wrong outcome this check exists to refuse."""
    res_lat = abs(lats[1] - lats[0])
    res_lon = abs(lons[1] - lons[0])
    radius_dlat = radius_m / M_PER_DEG_LAT
    radius_dlon = radius_m / m_per_deg_lon(latitude)
    return (
        lats[0] + res_lat - latitude > radius_dlat
        and latitude - (lats[-1] - res_lat) > radius_dlat
        and longitude - (lons[0] - res_lon) > radius_dlon
        and lons[-1] + res_lon - longitude > radius_dlon
    )


def percentile_below(values, point_elevation: float) -> float:
    """The point's percentile rank among the disc's terrain, 0–100: the
    fraction strictly below plus half of the ties, so a point inside a
    flat disc ranks 50, the summit ~100."""
    values = numpy.asarray(values)
    below = int(numpy.count_nonzero(values < point_elevation))
    ties = int(numpy.count_nonzero(values == point_elevation))
    return 100.0 * (below + 0.5 * ties) / values.size


def land_cover_name(code: int) -> str:
    try:
        return LAND_COVER_CLASSES[code]
    except KeyError:
        raise RuntimeError(
            f"WorldCover published class code {code}, which is not in the "
            "v200 taxonomy — refusing to guess what it means"
        ) from None


def class_fractions(values) -> dict[str, float]:
    """Class-name → fraction of the disc, descending fraction so the
    document reads dominant-cover-first. Classes absent from the disc are
    omitted (the map is wall-to-wall: absence means zero), and so are
    traces that would publish as 0 at the contract's three decimals — an
    explicit zero says nothing an omission doesn't. Pixels of the nodata
    code 0 are excluded from the denominator. Every code present is
    validated against the taxonomy, traces included: an unknown code is
    an upstream taxonomy change and must never be silently dropped."""
    values = numpy.asarray(values)
    values = values[values != 0]
    if values.size == 0:
        raise RuntimeError(
            "land-cover disc contains only nodata — WorldCover is "
            "wall-to-wall, so the coordinates are likely wrong"
        )
    codes, counts = numpy.unique(values, return_counts=True)
    names = {int(code): land_cover_name(int(code)) for code in codes}
    ranked = sorted(zip(codes, counts), key=lambda pair: (-pair[1], pair[0]))
    return {
        names[int(code)]: fraction
        for code, count in ranked
        if round(fraction := float(count) / values.size, 3) > 0
    }


# -------------------------------------------------- window → context blocks


def terrain_from_window(arr, lats, lons, site: dict, radii_m=RELIEF_RADII_M) -> dict:
    """The terrain block from one streamed GLO-30 window: bilinear point
    elevation, Horn slope/aspect at the nearest pixel, and relief discs.
    Nodata anywhere the analysis needs a value is a hard failure — the
    DEM is wall-to-wall over land, so a gap means the coordinates are
    wrong, and a plausible-but-wrong document is the one outcome this
    command must never produce."""
    latitude, longitude = site["latitude"], site["longitude"]
    elevation = bilinear(arr, lats, lons, latitude, longitude)
    if elevation is None:
        raise RuntimeError(
            f"{site['slug']}: GLO-30 returned nodata at "
            f"{latitude}, {longitude} — check the catalogued coordinates"
        )

    row = int(round((latitude - lats[0]) / (lats[1] - lats[0])))
    col = int(round((longitude - lons[0]) / (lons[1] - lons[0])))
    neighbourhood = arr[row - 1 : row + 2, col - 1 : col + 2]
    if neighbourhood.shape != (3, 3) or (
        numpy.ma.isMaskedArray(neighbourhood) and neighbourhood.mask.any()
    ):
        raise RuntimeError(
            f"{site['slug']}: GLO-30 has nodata in the slope neighbourhood at "
            f"{latitude}, {longitude} — check the catalogued coordinates"
        )
    xres_m = abs(lons[1] - lons[0]) * m_per_deg_lon(latitude)
    yres_m = abs(lats[1] - lats[0]) * M_PER_DEG_LAT
    slope, aspect = horn_slope_aspect(
        numpy.ma.filled(neighbourhood.astype(numpy.float64), numpy.nan), xres_m, yres_m
    )

    relief = []
    for radius_m in radii_m:
        if not disc_is_covered(lats, lons, latitude, longitude, radius_m):
            raise RuntimeError(
                f"{site['slug']}: the {radius_m / 1000:g} km relief disc crosses "
                "the GLO-30 tile edge; stitching neighbouring tiles is not "
                "implemented"
            )
        inside = arr[disc_mask(lats, lons, latitude, longitude, radius_m)]
        values = (
            inside.compressed()
            if numpy.ma.isMaskedArray(inside)
            else numpy.asarray(inside)
        )
        if values.size == 0:
            raise RuntimeError(
                f"{site['slug']}: the {radius_m / 1000:g} km relief disc has no "
                "GLO-30 data — check the catalogued coordinates"
            )
        relief.append(
            {
                "radiusKm": radius_m / 1000,
                "minM": float(values.min()),
                "maxM": float(values.max()),
                "percentile": percentile_below(values, elevation),
            }
        )
    return {
        "source": GLO30_ID,
        "elevationM": elevation,
        "slopeDeg": slope,
        "aspectDeg": aspect,
        "relief": relief,
    }


def land_cover_from_window(
    arr, lats, lons, site: dict, radii_m=LAND_COVER_RADII_M
) -> dict:
    """The landCover block from one streamed WorldCover window: the class
    of the nearest pixel at the launch, and disc composition. Code 0 at
    the launch is nodata in a wall-to-wall map — a hard failure."""
    latitude, longitude = site["latitude"], site["longitude"]
    row = int(round((latitude - lats[0]) / (lats[1] - lats[0])))
    col = int(round((longitude - lons[0]) / (lons[1] - lons[0])))
    code = int(numpy.ma.filled(arr, 0)[row, col])
    if code == 0:
        raise RuntimeError(
            f"{site['slug']}: WorldCover returned nodata at "
            f"{latitude}, {longitude} — check the catalogued coordinates"
        )
    fractions = []
    for radius_m in radii_m:
        if not disc_is_covered(lats, lons, latitude, longitude, radius_m):
            raise RuntimeError(
                f"{site['slug']}: the {radius_m / 1000:g} km land-cover disc "
                "crosses the WorldCover tile edge; stitching neighbouring "
                "tiles is not implemented"
            )
        fractions.append(
            {
                "radiusKm": radius_m / 1000,
                "byClass": class_fractions(
                    numpy.ma.filled(arr, 0)[
                        disc_mask(lats, lons, latitude, longitude, radius_m)
                    ]
                ),
            }
        )
    return {
        "source": WORLDCOVER_ID,
        "atLaunch": land_cover_name(code),
        "fractions": fractions,
    }


def lidarbc_candidates(payload: dict) -> list[str]:
    """DEM GeoTIFF URLs from a LidarBC tile-index FeatureServer response,
    newest acquisition year first — reflights index the same BCGS tile
    under several years, and the newest survey is the ground truth."""
    attributes = [
        feature.get("attributes") or {} for feature in payload.get("features") or []
    ]
    ranked = sorted(
        (entry for entry in attributes if entry.get("s3Url")),
        key=lambda entry: entry.get("year") or 0,
        reverse=True,
    )
    return [entry["s3Url"] for entry in ranked]


# ---------------------------------------------------------------- assembly


def build_document(
    sites: list[dict], *, terrain_of, bare_earth_of, land_cover_of, generated_at: str
) -> dict:
    """Assembles the site-context document (unrounded) from per-site
    samplers, printing a one-line summary per site as it goes. sources[]
    lists exactly the sources some site block references, in catalogue
    order, so licences never dangle and never go missing."""
    entries: dict[str, dict] = {}
    referenced: set[str] = set()
    for site in sites:
        slug = site["slug"]
        terrain = terrain_of(site)
        bare_earth = bare_earth_of(site)
        land_cover = land_cover_of(site)
        entry = {"terrain": terrain}
        if bare_earth is not None:
            entry["bareEarth"] = bare_earth
        entry["landCover"] = land_cover
        entries[slug] = entry
        referenced.update(
            block["source"] for block in (terrain, bare_earth, land_cover) if block
        )

        surveyed = site["elevationM"]
        if abs(terrain["elevationM"] - surveyed) > SURVEY_DISAGREEMENT_WARN_M:
            print(
                f"WARN {slug}: terrain elevation {terrain['elevationM']:.1f} m is "
                f"{terrain['elevationM'] - surveyed:+.1f} m from the surveyed "
                f"{surveyed} m — likely a coordinate mistake in sites.json",
                file=sys.stderr,
            )
        bare_note = (
            f", bare earth {bare_earth['source']} {bare_earth['elevationM']:.1f} m"
            if bare_earth is not None
            else ", no bare-earth coverage"
        )
        print(
            f"{slug}: {terrain['elevationM']:.1f} m (surveyed {surveyed} m), "
            f"slope {terrain['slopeDeg']:.1f}° aspect "
            f"{round(terrain['aspectDeg']) % 360}°, {land_cover['atLaunch']}"
            f"{bare_note}"
        )
    return {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": generated_at,
        "sources": [
            SOURCES[source_id] for source_id in SOURCES if source_id in referenced
        ],
        "sites": entries,
    }


# ----------------------------------------------------------- live sampling


def _import_rasterio():
    try:
        import rasterio
    except ImportError as error:
        raise RuntimeError(
            "the terrain command needs rasterio and numpy — "
            "install the terrain extra: uv sync --project pipeline --extra terrain"
        ) from error
    return rasterio


def _window(dataset, latitude: float, longitude: float, half_m: float):
    """Streams the window of a geographic (EPSG:4326) COG centred on the
    point and extending half_m each way; returns the masked array plus
    pixel-centre coordinate vectors. The window clamps to the tile — the
    read margin may legitimately overhang the pixel grid by a fraction of
    a pixel (red-mountain sits 10.2 km above its tile's south edge) —
    and disc_is_covered() decides downstream whether a clamped edge
    actually truncated an analysis disc."""
    from rasterio.windows import Window

    dlat = half_m / M_PER_DEG_LAT
    dlon = half_m / m_per_deg_lon(latitude)
    row0, col0 = dataset.index(longitude - dlon, latitude + dlat)
    row1, col1 = dataset.index(longitude + dlon, latitude - dlat)
    row0, col0 = max(0, row0), max(0, col0)
    row1, col1 = min(dataset.height - 1, row1), min(dataset.width - 1, col1)
    window = Window(col0, row0, col1 - col0 + 1, row1 - row0 + 1)
    arr = dataset.read(1, window=window, masked=True)
    transform = dataset.window_transform(window)
    lons = transform.c + (numpy.arange(arr.shape[1]) + 0.5) * transform.a
    lats = transform.f + (numpy.arange(arr.shape[0]) + 0.5) * transform.e
    return arr, lats, lons


def _projected_point(dataset, latitude: float, longitude: float) -> float | None:
    """Bilinear elevation from a projected-CRS DTM (LidarBC EPSG:2955,
    MRDEM EPSG:3979): reproject the point, stream a 5×5 window,
    interpolate in projected coordinates. None — not an error — when the
    point is outside the raster or on nodata: for a DTM, absence means
    "not measured" and the caller tries the next candidate."""
    from rasterio.warp import transform as warp_transform
    from rasterio.windows import Window

    xs, ys = warp_transform("EPSG:4326", dataset.crs, [longitude], [latitude])
    x, y = xs[0], ys[0]
    row, col = dataset.index(x, y)
    if not (2 <= row < dataset.height - 2 and 2 <= col < dataset.width - 2):
        return None
    window = Window(col - 2, row - 2, 5, 5)
    arr = dataset.read(1, window=window, masked=True)
    transform = dataset.window_transform(window)
    fx = (x - (transform.c + 0.5 * transform.a)) / transform.a
    fy = (y - (transform.f + 0.5 * transform.e)) / transform.e
    x0, y0 = math.floor(fx), math.floor(fy)
    quad = arr[y0 : y0 + 2, x0 : x0 + 2]
    if quad.shape != (2, 2) or (numpy.ma.isMaskedArray(quad) and quad.mask.any()):
        return None
    quad = numpy.ma.filled(quad.astype(numpy.float64), numpy.nan)
    tx, ty = fx - x0, fy - y0
    return float(
        quad[0, 0] * (1 - tx) * (1 - ty)
        + quad[0, 1] * tx * (1 - ty)
        + quad[1, 0] * (1 - tx) * ty
        + quad[1, 1] * tx * ty
    )


def _lidarbc_urls(latitude: float, longitude: float) -> list[str]:
    """DEM tiles indexing the point, from the LidarBC FeatureServer
    [verified 2026-08-10: layer 6 is the 1 m DEM tile index; features
    carry `s3Url` (GeoTIFF on nrs.objectstore.gov.bc.ca) and `year`]."""
    response = requests.get(
        LIDARBC_QUERY_URL,
        params={
            "geometry": f"{longitude},{latitude}",
            "geometryType": "esriGeometryPoint",
            "inSR": "4326",
            "spatialRel": "esriSpatialRelIntersects",
            "outFields": "year,s3Url",
            "returnGeometry": "false",
            "f": "json",
        },
        timeout=REQUEST_TIMEOUT_S,
    )
    response.raise_for_status()
    payload = response.json()
    # ArcGIS reports failures as HTTP 200 with an error body; treating
    # that as "no coverage" would silently drop bare-earth blocks.
    if "error" in payload:
        raise RuntimeError(f"LidarBC tile index query failed: {payload['error']}")
    return lidarbc_candidates(payload)


def generate(sites: list[dict], output_path: Path) -> int:
    """The `windgram terrain` command body: sample every site from the
    live endpoints and write the rounded document, indented so it diffs
    well in git."""
    rasterio = _import_rasterio()
    generated_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    opened: dict[str, object] = {}

    def dataset(url: str):
        if url not in opened:
            opened[url] = rasterio.open(f"/vsicurl/{url}")
        return opened[url]

    def terrain_of(site: dict) -> dict:
        url = glo30_url(site["latitude"], site["longitude"])
        arr, lats, lons = _window(
            dataset(url),
            site["latitude"],
            site["longitude"],
            max(RELIEF_RADII_M) + 200,
        )
        return terrain_from_window(arr, lats, lons, site)

    def bare_earth_of(site: dict) -> dict | None:
        # LidarBC candidates newest-first, then the national MRDEM; a
        # nodata candidate is "not measured here", so the next one gets
        # its chance, and when everything declines the block is omitted.
        for url in _lidarbc_urls(site["latitude"], site["longitude"]):
            elevation = _projected_point(
                dataset(url), site["latitude"], site["longitude"]
            )
            if elevation is not None:
                return {"source": LIDARBC_ID, "elevationM": elevation}
        elevation = _projected_point(
            dataset(MRDEM30_URL), site["latitude"], site["longitude"]
        )
        if elevation is not None:
            return {"source": MRDEM30_ID, "elevationM": elevation}
        return None

    def land_cover_of(site: dict) -> dict:
        url = worldcover_url(site["latitude"], site["longitude"])
        arr, lats, lons = _window(
            dataset(url),
            site["latitude"],
            site["longitude"],
            max(LAND_COVER_RADII_M) + 100,
        )
        return land_cover_from_window(arr, lats, lons, site)

    with rasterio.Env(
        AWS_NO_SIGN_REQUEST="YES",
        GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR",
        VSI_CACHE="TRUE",
    ):
        try:
            document = build_document(
                sites,
                terrain_of=terrain_of,
                bare_earth_of=bare_earth_of,
                land_cover_of=land_cover_of,
                generated_at=generated_at,
            )
        finally:
            for handle in opened.values():
                handle.close()

    output_path.parent.mkdir(parents=True, exist_ok=True)
    write_json(output_path, round_document(document), compact=False)
    print(f"Wrote terrain context for {len(sites)} site(s) to {output_path}.")
    return 0
