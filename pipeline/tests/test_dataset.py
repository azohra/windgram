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
