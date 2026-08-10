"""Loads the catalogued launch sites every builder samples.

sites.json is a versioned envelope — {"schemaVersion": 2, "sites": [...]} —
holding identity only: slug, name, coordinates, optional what3words, and
the IANA timezone. Git authors identity; the pipeline owns ground truth:
the operative launch elevation lives in the committed site-context.json
that `windgram terrain` derives from open elevation data. `load_sites`
validates the input against the input contract
(toolkit/schema/sites-input.schema.json, mirrored here as explicit checks
so an installed pipeline needs no checkout beside it), then joins the
context by slug so every builder keeps reading site["elevationM"] without
knowing where it came from.

A site missing from the context is a loud failure, never a silent gap:
adding a site to sites.json forces the terrain enrichment, so the two
files can only land together.
"""

from __future__ import annotations

import json
from pathlib import Path

from .config import sites_path

SITES_SCHEMA_VERSION = 2
CONTEXT_SCHEMA_VERSION = 2

# The one command that repairs every "context is missing/stale" failure —
# the messages name it so the fix is a paste, not a search.
TERRAIN_FIX = (
    "run: uv sync --project pipeline --extra terrain && "
    "uv run --project pipeline windgram terrain"
)

_REQUIRED_SITE_FIELDS = (
    ("slug", str),
    ("name", str),
    ("latitude", (int, float)),
    ("longitude", (int, float)),
    ("timeZone", str),
)


def load_sites_input(path: Path | None = None) -> list[dict]:
    """The hand-authored identity catalogue, validated but NOT joined —
    what `windgram terrain` reads (joining there would chicken-and-egg on
    the very first generation)."""
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
        for field, kind in _REQUIRED_SITE_FIELDS:
            value = site.get(field) if isinstance(site, dict) else None
            if not isinstance(value, kind) or isinstance(value, bool) or value == "":
                raise RuntimeError(
                    f"{path}: site {site.get('slug') if isinstance(site, dict) else site!r} "
                    f"is missing or mistypes the required field {field!r}"
                )
        if "what3words" in site and not isinstance(site["what3words"], str):
            raise RuntimeError(
                f"{path}: site {site['slug']!r} mistypes optional what3words"
            )
    return sites


def load_site_context(path: Path) -> dict:
    """The committed derived-ground-truth document, version-checked. Its
    absence (or a pre-elevation version) means the enrichment has not run
    against this catalogue — a loud failure naming the fix."""
    if not path.exists():
        raise RuntimeError(
            f"site context {path} does not exist — the committed "
            f"site-context.json is the elevation authority; {TERRAIN_FIX}"
        )
    context = json.loads(path.read_text())
    version = context.get("schemaVersion") if isinstance(context, dict) else None
    if version != CONTEXT_SCHEMA_VERSION:
        raise RuntimeError(
            f"{path} declares schemaVersion {version!r}; this pipeline joins "
            f"version {CONTEXT_SCHEMA_VERSION} — {TERRAIN_FIX}"
        )
    return context


def context_elevation(context: dict, slug: str, context_path: Path) -> dict:
    """One site's elevation block from the context — {source, elevationM}.
    A catalogued site the context has never seen fails loudly: the commit
    that adds a site must carry its enrichment."""
    entry = context["sites"].get(slug)
    if entry is None or "elevation" not in entry:
        raise RuntimeError(
            f"site {slug!r} has no elevation in {context_path} — the derived "
            f"context must cover every catalogued site; {TERRAIN_FIX}"
        )
    return entry["elevation"]


def load_sites(path: Path | None = None, context_path: Path | None = None) -> list[dict]:
    """Identity joined with derived ground truth: every returned site dict
    carries the context's operative `elevationM` beside the input fields.
    The context defaults to site-context.json beside the sites file."""
    path = sites_path() if path is None else path
    sites = load_sites_input(path)
    if context_path is None:
        context_path = path.parent / "site-context.json"
    context = load_site_context(context_path)
    return [
        {
            **site,
            "elevationM": context_elevation(context, site["slug"], context_path)[
                "elevationM"
            ],
        }
        for site in sites
    ]
