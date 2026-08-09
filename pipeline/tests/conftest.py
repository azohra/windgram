import pytest


@pytest.fixture(autouse=True)
def _clean_datamart_env(monkeypatch):
    """URL tests assert the dd default; a shell exporting the Datamart
    override must not bleed into the suite."""
    monkeypatch.delenv("WINDGRAM_DATAMART_BASE", raising=False)
