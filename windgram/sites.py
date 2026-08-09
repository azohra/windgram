"""Loads the catalogued launch sites every builder samples.

sites.json is a versioned envelope — {"schemaVersion": 1, "sites": [...]} —
so the catalogue's shape can evolve without breaking readers silently: a
version this loader does not speak fails loudly before any download.
"""

from __future__ import annotations

import json
from pathlib import Path

from .config import sites_path

SITES_SCHEMA_VERSION = 1


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
    return sites
