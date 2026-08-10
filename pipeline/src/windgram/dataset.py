"""Read side of the published dataset.

Builders never learn what is already published from the scratch output
tree — they ask the public data base over plain HTTPS: the manifest for
the already-published check and the runs index, the month archives that
history appends continue. WINDGRAM_DATA_BASE selects the base per
invocation (an external publisher points it at their own published
tree); a 404 means "not yet published" — the first run of a model, or
the first run of a site's month, is normal. Retries follow the Datamart
client's manners: three attempts with jittered backoff, only 429s,
5xx, and transport errors retried.
"""

from __future__ import annotations

import json
import os
import random
import threading
import time

import requests

from .datamart import USER_AGENT

DATA_URL = "https://data.meteo.azohra.com"
REQUEST_TIMEOUT_S = 60


def data_base() -> str:
    """The data base URL for this invocation, read from the environment on
    every call so tests and workflow env both take effect without
    import-order traps."""
    return os.environ.get("WINDGRAM_DATA_BASE", DATA_URL).rstrip("/")


_session_local = threading.local()


def _session() -> requests.Session:
    session = getattr(_session_local, "session", None)
    if session is None:
        session = requests.Session()
        session.headers["User-Agent"] = USER_AGENT
        _session_local.session = session
    return session


def fetch_published(path: str) -> bytes | None:
    """GET <data base>/<path>: the object's bytes, or None when nothing is
    published there (HTTP 404). Any other client error stays fatal; 429s,
    5xx, and transport errors are retried before failing."""
    url = f"{data_base()}/{path.lstrip('/')}"
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            response = _session().get(url, timeout=REQUEST_TIMEOUT_S)
            if response.status_code == 200:
                return response.content
            if response.status_code == 404:
                return None
            if response.status_code != 429 and response.status_code < 500:
                raise RuntimeError(f"data base {url} failed with {response.status_code}")
            last_error = RuntimeError(f"data base {url} failed with {response.status_code}")
        except requests.RequestException as error:
            last_error = error
        if attempt < 2:
            time.sleep(0.25 * (2**attempt) * (0.75 + random.random() * 0.5))
    assert last_error is not None
    raise last_error


def published_manifest(model_slug: str) -> dict | None:
    """The model's published manifest, or None when the model has never
    published (the runs index tolerates exactly this)."""
    payload = fetch_published(f"{model_slug}/manifest.json")
    return None if payload is None else json.loads(payload)


def published_reference_time(model_slug: str) -> str | None:
    """The referenceTime of the model's published run — the builders'
    already-published check. None means nothing is published yet."""
    manifest = published_manifest(model_slug)
    return None if manifest is None else manifest.get("referenceTime")


def published_history(model_slug: str, site_id: str, month: str) -> bytes:
    """The raw gzip bytes of one site's month archive, empty when the
    month has no archive yet."""
    payload = fetch_published(f"{model_slug}/history/{site_id}/{month}.jsonl.gz")
    return b"" if payload is None else payload
