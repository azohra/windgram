from types import SimpleNamespace

import pytest

from windgram import datamart
from windgram.datamart import DownloadStats, NotFoundError, datamart_base, fetch_bytes


def test_datamart_base_defaults_to_dd():
    assert datamart_base() == "https://dd.weather.gc.ca"


def test_datamart_base_reads_the_override_per_call(monkeypatch):
    monkeypatch.setenv("WINDGRAM_DATAMART_BASE", "https://hpfx.collab.science.gc.ca/")
    assert datamart_base() == "https://hpfx.collab.science.gc.ca"


class _Session:
    def __init__(self, responses):
        self._responses = list(responses)

    def get(self, url, timeout=None):
        return self._responses.pop(0)


def _response(status_code: int, content: bytes = b"") -> SimpleNamespace:
    return SimpleNamespace(status_code=status_code, content=content, headers={})


def test_a_404_is_not_found_and_never_retried(monkeypatch):
    monkeypatch.setattr(datamart, "_session", lambda: _Session([_response(404)]))
    stats = DownloadStats()
    with pytest.raises(NotFoundError):
        fetch_bytes("https://dd.weather.gc.ca/nowhere.grib2", stats)
    assert stats.requests == 1
    assert stats.retries == 0


def test_other_client_errors_stay_fatal_but_are_not_not_found(monkeypatch):
    monkeypatch.setattr(datamart, "_session", lambda: _Session([_response(403)]))
    with pytest.raises(RuntimeError) as caught:
        fetch_bytes("https://dd.weather.gc.ca/forbidden.grib2")
    assert not isinstance(caught.value, NotFoundError)


def test_server_errors_are_retried_before_failing(monkeypatch):
    monkeypatch.setattr(datamart.time, "sleep", lambda seconds: None)
    monkeypatch.setattr(
        datamart, "_session", lambda: _Session([_response(500)] * 3)
    )
    stats = DownloadStats()
    with pytest.raises(RuntimeError, match="failed with 500"):
        fetch_bytes("https://dd.weather.gc.ca/flaky.grib2", stats)
    assert stats.requests == 3
    assert stats.retries == 2
