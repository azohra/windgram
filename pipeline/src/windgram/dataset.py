"""Read side of the published dataset.

Builders never learn what is already published from the scratch output
tree — they ask the published dataset itself: the manifest for the
already-published check and the runs index, the month archives that
history appends continue. A read that finds nothing means "not yet
published" — the first run of a model, or the first run of a site's
month, is normal. Retries follow the Datamart client's manners: three
attempts with jittered backoff, only throttling, 5xx, and transport
errors retried.

Two transports, selected per call from the environment:

- **Authenticated S3** when WINDGRAM_DATA_BASE is unset AND the upload
  credentials are present (R2_ENDPOINT + AWS_ACCESS_KEY_ID +
  AWS_SECRET_ACCESS_KEY — exactly what the upload script already uses):
  boto3 get_object against the bucket (WINDGRAM_R2_BUCKET, default
  meteo-data) on that endpoint, so Cloudflare never mediates the
  pipeline's own reads. NoSuchKey is true absence, unambiguously;
  AccessDenied is FATAL — this process HOLDS credentials, so denial is
  misconfiguration, never absence.
- **Public HTTPS** otherwise. Setting WINDGRAM_DATA_BASE always forces
  this path, credentials or not — an external publisher points it at
  their own published tree — and it keeps the Cloudflare-challenge
  fatality that protects local dev and external publishers from
  silently reading a bot challenge as an empty dataset.
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
S3_BUCKET = "meteo-data"
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


def _s3_mode() -> bool:
    """Whether this invocation reads through the authenticated S3 API:
    only when WINDGRAM_DATA_BASE is unset (an explicit base always wins)
    and the full upload credential set is present. Read per call, like
    data_base(), so tests and workflow env take effect without
    import-order traps."""
    return not os.environ.get("WINDGRAM_DATA_BASE") and all(
        os.environ.get(name)
        for name in ("R2_ENDPOINT", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY")
    )


def _s3_bucket() -> str:
    return os.environ.get("WINDGRAM_R2_BUCKET", S3_BUCKET)


def _s3_client():
    endpoint = os.environ["R2_ENDPOINT"]
    if getattr(_session_local, "s3_endpoint", None) != endpoint:
        import boto3  # a regular dependency, imported lazily to keep module import light

        _session_local.s3_client = boto3.client("s3", endpoint_url=endpoint)
        _session_local.s3_endpoint = endpoint
    return _session_local.s3_client


# ClientError codes that are transient by nature — the S3 spelling of the
# HTTP path's "429s and 5xx".
_RETRYABLE_S3_CODES = {
    "InternalError",
    "RequestTimeout",
    "ServiceUnavailable",
    "SlowDown",
    "Throttling",
    "ThrottlingException",
}


def _fetch_published_s3(key: str) -> bytes | None:
    """get_object through the authenticated endpoint. NoSuchKey → None
    (true absence — no Cloudflare, no ambiguous 403); AccessDenied →
    FATAL with the fix named; throttling, 5xx, and transport errors get
    the same three-attempt manners as the HTTP path."""
    from botocore.exceptions import BotoCoreError, ClientError

    bucket = _s3_bucket()
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            response = _s3_client().get_object(Bucket=bucket, Key=key)
            return response["Body"].read()
        except ClientError as error:
            code = (error.response.get("Error") or {}).get("Code")
            status = (error.response.get("ResponseMetadata") or {}).get(
                "HTTPStatusCode", 0
            )
            if code == "NoSuchKey":
                return None
            if code == "AccessDenied":
                raise RuntimeError(
                    f"s3://{bucket}/{key} on {os.environ['R2_ENDPOINT']} answered "
                    "AccessDenied: this process holds credentials, so denial is "
                    "a misconfigured token or bucket policy — never absence. Fix "
                    "the R2 token's read permission, or unset R2_ENDPOINT / "
                    "AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY to read the "
                    "public base."
                ) from error
            if code not in _RETRYABLE_S3_CODES and status < 500:
                raise RuntimeError(
                    f"s3://{bucket}/{key} failed with {code or status}"
                ) from error
            last_error = error
        except BotoCoreError as error:
            last_error = error
        if attempt < 2:
            time.sleep(0.25 * (2**attempt) * (0.75 + random.random() * 0.5))
    assert last_error is not None
    raise last_error


def fetch_published(path: str) -> bytes | None:
    """The object's bytes at <path> under the published dataset root, or
    None when nothing is published there — through the authenticated S3
    API when _s3_mode() holds, else GET <data base>/<path>.

    On the public path, absence is TWO status codes: 404, and the 403
    that S3-style storage returns for a missing key when listing is
    denied — every dataset's very first build asks for a manifest that
    has never existed and gets the 403 (verified against the live base
    2026-08-10, the goes18-dsr cold start). Any other client error stays
    fatal; 429s, 5xx, and transport errors are retried before failing."""
    if _s3_mode():
        return _fetch_published_s3(path.lstrip("/"))
    url = f"{data_base()}/{path.lstrip('/')}"
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            response = _session().get(url, timeout=REQUEST_TIMEOUT_S)
            if response.status_code == 200:
                return response.content
            if response.status_code in (403, 404):
                # A 403 is absence ONLY when it is the S3-style
                # missing-key denial. A Cloudflare bot challenge also
                # answers 403 — identified by its cf-mitigated header —
                # and treating THAT as absence makes every builder see
                # an empty dataset and silently reset incremental state
                # (observed 2026-08-10: CI runners were challenged on
                # every read and published runs.json as {} while the
                # dataset sat fully populated). A challenged read is a
                # broken read, never absence — fail loudly and name the
                # fix.
                if response.headers.get("cf-mitigated") == "challenge":
                    raise RuntimeError(
                        f"data base {url} answered a Cloudflare bot challenge "
                        "(cf-mitigated: challenge): automated reads from this "
                        "network are blocked. Fix the zone's WAF/bot rules for "
                        "the data hostname; treating a challenge as 'not yet "
                        "published' would silently reset incremental state."
                    )
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
