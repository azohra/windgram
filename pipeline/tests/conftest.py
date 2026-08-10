import pytest


@pytest.fixture(autouse=True)
def _clean_datamart_env(monkeypatch):
    """URL tests assert the dd and data-base defaults; a shell exporting
    either override must not bleed into the suite. R2_ENDPOINT would flip
    dataset reads into the authenticated S3 mode — the suite must stay on
    the public path unless a test opts in."""
    monkeypatch.delenv("WINDGRAM_DATAMART_BASE", raising=False)
    monkeypatch.delenv("WINDGRAM_DATA_BASE", raising=False)
    monkeypatch.delenv("R2_ENDPOINT", raising=False)
    monkeypatch.delenv("WINDGRAM_R2_BUCKET", raising=False)
