import json
from types import SimpleNamespace

import pytest

from windgram import dataset
from windgram.dataset import (
    data_base,
    fetch_published,
    published_history,
    published_manifest,
    published_reference_time,
)


def test_data_base_defaults_to_the_public_url():
    assert data_base() == "https://data.meteo.azohra.com"


def test_data_base_reads_the_override_per_call(monkeypatch):
    monkeypatch.setenv("WINDGRAM_DATA_BASE", "https://club.example.com/windgrams/")
    assert data_base() == "https://club.example.com/windgrams"


class _Session:
    def __init__(self, responses):
        self.requested_urls = []
        self._responses = list(responses)

    def get(self, url, timeout=None):
        self.requested_urls.append(url)
        return self._responses.pop(0)


def _response(status_code: int, content: bytes = b"", headers: dict | None = None) -> SimpleNamespace:
    return SimpleNamespace(status_code=status_code, content=content, headers=headers or {})


def test_fetches_from_the_configured_base(monkeypatch):
    monkeypatch.setenv("WINDGRAM_DATA_BASE", "https://club.example.com")
    session = _Session([_response(200, b"payload")])
    monkeypatch.setattr(dataset, "_session", lambda: session)

    assert fetch_published("gfs/manifest.json") == b"payload"
    assert session.requested_urls == ["https://club.example.com/gfs/manifest.json"]


def test_a_404_means_not_yet_published_and_is_never_retried(monkeypatch):
    session = _Session([_response(404)])
    monkeypatch.setattr(dataset, "_session", lambda: session)

    assert fetch_published("gfs/manifest.json") is None
    assert len(session.requested_urls) == 1


def test_a_403_means_not_yet_published_like_a_404(monkeypatch):
    # S3-style storage answers 403 for a missing key when listing is
    # denied — a dataset's very first build asks for a manifest that has
    # never existed and must read the 403 as absence, not failure
    # (verified against the live base 2026-08-10, the goes18-dsr cold
    # start).
    session = _Session([_response(403)])
    monkeypatch.setattr(dataset, "_session", lambda: session)
    assert fetch_published("goes18-dsr/manifest.json") is None
    assert len(session.requested_urls) == 1


def test_a_cloudflare_challenge_403_is_fatal_never_absence(monkeypatch):
    # A bot-challenge 403 (cf-mitigated: challenge) is a BROKEN read:
    # reading it as "not yet published" made CI publish runs.json as {}
    # and would reset every incremental window [observed 2026-08-10].
    session = _Session([_response(403, headers={"cf-mitigated": "challenge"})])
    monkeypatch.setattr(dataset, "_session", lambda: session)
    with pytest.raises(RuntimeError, match="Cloudflare bot challenge"):
        dataset.fetch_published("hrdps-west/manifest.json")
    assert len(session.requested_urls) == 1  # fatal immediately, no retry


def test_other_client_errors_stay_fatal(monkeypatch):
    monkeypatch.setattr(dataset, "_session", lambda: _Session([_response(401)]))
    with pytest.raises(RuntimeError, match="failed with 401"):
        fetch_published("gfs/manifest.json")


def test_server_errors_are_retried_before_failing(monkeypatch):
    monkeypatch.setattr(dataset.time, "sleep", lambda seconds: None)
    session = _Session([_response(500)] * 3)
    monkeypatch.setattr(dataset, "_session", lambda: session)

    with pytest.raises(RuntimeError, match="failed with 500"):
        fetch_published("gfs/manifest.json")
    assert len(session.requested_urls) == 3


def test_a_retry_can_recover(monkeypatch):
    monkeypatch.setattr(dataset.time, "sleep", lambda seconds: None)
    session = _Session([_response(503), _response(200, b"recovered")])
    monkeypatch.setattr(dataset, "_session", lambda: session)

    assert fetch_published("runs.json") == b"recovered"


def test_published_manifest_parses_json_and_reports_absence(monkeypatch):
    manifest = {"model": "gfs", "referenceTime": "2026-08-09T06:00:00Z"}
    monkeypatch.setattr(
        dataset, "_session", lambda: _Session([_response(200, json.dumps(manifest).encode())])
    )
    assert published_manifest("gfs") == manifest

    monkeypatch.setattr(dataset, "_session", lambda: _Session([_response(404)]))
    assert published_manifest("gfs") is None


def test_published_reference_time_is_none_before_a_first_run(monkeypatch):
    monkeypatch.setattr(dataset, "_session", lambda: _Session([_response(404)]))
    assert published_reference_time("gfs") is None

    manifest = {"model": "gfs", "referenceTime": "2026-08-09T06:00:00Z"}
    monkeypatch.setattr(
        dataset, "_session", lambda: _Session([_response(200, json.dumps(manifest).encode())])
    )
    assert published_reference_time("gfs") == "2026-08-09T06:00:00Z"


def test_published_history_is_empty_for_a_new_month(monkeypatch):
    session = _Session([_response(404)])
    monkeypatch.setattr(dataset, "_session", lambda: session)

    assert published_history("gfs", "dundee", "2026-08") == b""
    assert session.requested_urls == [
        "https://data.meteo.azohra.com/gfs/history/dundee/2026-08.jsonl.gz"
    ]


# ------------------------------------------------- authenticated S3 reads


def _client_error(code: str, status: int):
    from botocore.exceptions import ClientError

    return ClientError(
        {"Error": {"Code": code}, "ResponseMetadata": {"HTTPStatusCode": status}},
        "GetObject",
    )


class _Body:
    def __init__(self, payload: bytes):
        self._payload = payload

    def read(self) -> bytes:
        return self._payload


class _S3Client:
    """One scripted answer per call: bytes to return, or an exception to
    raise — no moto, just the seam fetch_published actually touches."""

    def __init__(self, answers):
        self.requested = []
        self._answers = list(answers)

    def get_object(self, Bucket, Key):
        self.requested.append((Bucket, Key))
        answer = self._answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return {"Body": _Body(answer)}


def _s3_env(monkeypatch):
    monkeypatch.setenv("R2_ENDPOINT", "https://account.r2.cloudflarestorage.com")
    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "key")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "secret")


def _install_client(monkeypatch, client):
    monkeypatch.setattr(dataset, "_s3_client", lambda: client)


def test_s3_mode_reads_the_bucket_and_returns_the_bytes(monkeypatch):
    _s3_env(monkeypatch)
    client = _S3Client([b"payload"])
    _install_client(monkeypatch, client)

    assert fetch_published("gfs/manifest.json") == b"payload"
    assert client.requested == [("meteo-data", "gfs/manifest.json")]


def test_s3_mode_honours_the_bucket_override(monkeypatch):
    _s3_env(monkeypatch)
    monkeypatch.setenv("WINDGRAM_R2_BUCKET", "meteo-data-staging")
    client = _S3Client([b"{}"])
    _install_client(monkeypatch, client)

    fetch_published("runs.json")
    assert client.requested == [("meteo-data-staging", "runs.json")]


def test_s3_nosuchkey_is_true_absence(monkeypatch):
    _s3_env(monkeypatch)
    client = _S3Client([_client_error("NoSuchKey", 404)])
    _install_client(monkeypatch, client)

    assert fetch_published("goes18-dsr/manifest.json") is None
    assert len(client.requested) == 1  # absence is certain, never retried


def test_s3_accessdenied_is_fatal_never_absence(monkeypatch):
    # On the public path a 403 can mean "missing key"; here we HOLD
    # credentials, so denial is a misconfigured token — treating it as
    # absence would silently reset every incremental window.
    _s3_env(monkeypatch)
    client = _S3Client([_client_error("AccessDenied", 403)])
    _install_client(monkeypatch, client)

    with pytest.raises(RuntimeError, match="AccessDenied.*misconfigured"):
        fetch_published("gfs/manifest.json")
    assert len(client.requested) == 1  # fatal immediately, no retry


def test_s3_throttling_is_retried_and_can_recover(monkeypatch):
    _s3_env(monkeypatch)
    monkeypatch.setattr(dataset.time, "sleep", lambda seconds: None)
    client = _S3Client([_client_error("SlowDown", 503), b"recovered"])
    _install_client(monkeypatch, client)

    assert fetch_published("runs.json") == b"recovered"
    assert len(client.requested) == 2


def test_s3_server_errors_exhaust_the_retry_budget_then_fail(monkeypatch):
    _s3_env(monkeypatch)
    monkeypatch.setattr(dataset.time, "sleep", lambda seconds: None)
    client = _S3Client([_client_error("InternalError", 500)] * 3)
    _install_client(monkeypatch, client)

    with pytest.raises(Exception, match="InternalError"):
        fetch_published("gfs/manifest.json")
    assert len(client.requested) == 3


def test_s3_other_client_errors_stay_fatal(monkeypatch):
    _s3_env(monkeypatch)
    client = _S3Client([_client_error("NoSuchBucket", 404)])
    _install_client(monkeypatch, client)

    with pytest.raises(RuntimeError, match="NoSuchBucket"):
        fetch_published("gfs/manifest.json")


def test_s3_mode_engages_only_with_the_full_credential_set(monkeypatch):
    assert dataset._s3_mode() is False  # conftest cleans the env

    _s3_env(monkeypatch)
    assert dataset._s3_mode() is True

    monkeypatch.delenv("AWS_SECRET_ACCESS_KEY")
    assert dataset._s3_mode() is False  # partial credentials → public path


def test_an_explicit_data_base_always_wins_over_credentials(monkeypatch):
    # The documented selection rule: S3 mode engages only when
    # WINDGRAM_DATA_BASE is unset. An external publisher pointing at
    # their own tree keeps the public path, credentials or not.
    _s3_env(monkeypatch)
    monkeypatch.setenv("WINDGRAM_DATA_BASE", "https://club.example.com")
    assert dataset._s3_mode() is False

    session = _Session([_response(200, b"payload")])
    monkeypatch.setattr(dataset, "_session", lambda: session)
    _install_client(monkeypatch, _S3Client([]))  # must never be touched

    assert fetch_published("gfs/manifest.json") == b"payload"
    assert session.requested_urls == ["https://club.example.com/gfs/manifest.json"]
