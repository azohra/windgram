import pytest


@pytest.fixture(autouse=True)
def _clean_datamart_env(monkeypatch):
    """URL tests assert the dd and data-base defaults; a shell exporting
    either override must not bleed into the suite."""
    monkeypatch.delenv("WINDGRAM_DATAMART_BASE", raising=False)
    monkeypatch.delenv("WINDGRAM_DATA_BASE", raising=False)
