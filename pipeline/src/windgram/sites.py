"""Loads the catalogued sites every builder samples.

sites.json is a versioned envelope — {"schemaVersion": 2, "sites": [...]} —
so the catalogue's shape can evolve without breaking readers silently: a
version this loader does not speak fails loudly before any download.

Since schemaVersion 2 the catalogue is identity and build selection ONLY:
slug, name, latitude, longitude, timeZone. Humans author WHERE; the
pipeline measures WHAT (elevation, terrain, land cover) from ground
observations into site-context.json (`windgram terrain`). An elevationM
in the input file means someone hasn't absorbed that split, so the loader
rejects it with directions rather than quietly ignoring it.
"""

from __future__ import annotations

import json
from pathlib import Path

from .config import sites_path

SITES_SCHEMA_VERSION = 2

# Identity and build selection, the whole catalogue vocabulary.
SITE_FIELDS = ("slug", "name", "latitude", "longitude", "timeZone")


def load_sites(path: Path | None = None) -> list[dict]:
    path = sites_path() if path is None else path
    document = json.loads(path.read_text())
    version = document.get("schemaVersion") if isinstance(document, dict) else None
    if version != SITES_SCHEMA_VERSION:
        raise RuntimeError(
            f"{path} declares schemaVersion {version!r}; "
            f"this pipeline reads version {SITES_SCHEMA_VERSION}"
        )
    sites = document["sites"]
    if not sites:
        raise RuntimeError(f"{path} lists no sites")
    for site in sites:
        _require_identity_only(site, path)
    return sites


def _require_identity_only(site: dict, path: Path) -> None:
    label = f"{path} site {site.get('slug', '<unnamed>')!r}"
    if "elevationM" in site:
        raise RuntimeError(
            f"{label} carries elevationM — the catalogue has been identity-only "
            "since schemaVersion 2: the pipeline measures elevation into "
            "site-context.json (`windgram terrain`). Delete the field and "
            "regenerate the context instead of typing an elevation here."
        )
    missing = [field for field in SITE_FIELDS if field not in site]
    if missing:
        raise RuntimeError(f"{label} is missing {', '.join(missing)}")
    unknown = sorted(set(site) - set(SITE_FIELDS))
    if unknown:
        raise RuntimeError(
            f"{label} carries unknown fields {', '.join(unknown)} — the "
            "catalogue is identity and build selection only"
        )
