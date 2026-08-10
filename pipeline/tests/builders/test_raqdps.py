import json
from pathlib import Path

import pytest

from windgram.builders import raqdps
from windgram.datamart import DownloadStats

SITE = {
    "slug": "dundee",
    "name": "Dundee",
    "latitude": 49.1,
    "longitude": -122.2,
    "elevationM": 550.0,
    "timeZone": "America/Vancouver",
}

# Live-verified SI base units (kg/m³, kg/m²) in, contract units (µg/m³,
# mg/m²) out — see the SMOKE_FIELDS comment in the builder.
RAW_VALUES = {
    "PM2.5_Sfc": 2.5e-8,
    "PM2.5-WildfireSmokePlume_Sfc": 1.5e-8,
    "PM2.5-WildfireSmokePlume_EAtm": 5.0e-6,
}


def test_models_json_matches_the_raqdps_builder_configuration():
    catalogue = json.loads(Path("models.json").read_text())
    (entry,) = catalogue["smokeModels"]

    assert entry["slug"] == "raqdps"
    assert entry["kind"] == "deterministic"
    assert entry["stepHours"] == 1
    assert entry["horizonHours"] == raqdps.FORECAST_HOURS == 72
    # Two runs a day, probed newest-first like the other ECCC builders.
    assert entry["runIntervalHours"] == 12
    assert raqdps.RUN_HOURS == ("12", "00")


def test_file_url_matches_the_datamart_layout():
    # Verified live 2026-08-09: the wildfire products are folded into the
    # plain model_raqdps tree (no model_raqdps-fw directory exists).
    url = raqdps._file_url("20260809", "12", 6, "PM2.5-WildfireSmokePlume_Sfc")
    assert url.endswith(
        "/20260809/WXO-DD/model_raqdps/10km/grib2/12/006/"
        "20260809T12Z_MSC_RAQDPS_PM2.5-WildfireSmokePlume_Sfc_RLatLon0.09_PT006H.grib2"
    )


class _FakeField:
    """Stands in for GribField: the fake fetch returns the URL, and the
    value is looked up from the variable token inside it."""

    def __init__(self, url: str):
        self.url = url

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def value_at(self, latitude: float, longitude: float, max_km: float) -> float:
        for variable, value in RAW_VALUES.items():
            if f"_{variable}_" in self.url:
                return value
        raise AssertionError(f"unexpected fetch: {self.url}")


def test_build_documents_publishes_the_converted_smoke_series(monkeypatch):
    monkeypatch.setenv("WINDGRAM_MAX_STEPS", "2")
    monkeypatch.setattr(raqdps, "fetch_bytes", lambda url, stats=None: url)
    monkeypatch.setattr(raqdps, "GribField", _FakeField)

    result = raqdps._build_documents(
        {"date": "20260809", "hour": "12"}, "2026-08-09T12:00:00Z", [SITE], DownloadStats()
    )

    assert result["firstForecastHour"] == 1
    assert result["forecastHours"] == 2
    (document,) = result["documents"]
    assert document["schemaVersion"] == 1
    assert document["model"] == "raqdps"
    assert document["run"]["referenceTime"] == "2026-08-09T12:00:00Z"
    # The site block carries identity and the timezone echo — no elevations:
    # terrain is a profile concern, not an air-quality one.
    assert document["site"] == {
        "id": "dundee",
        "name": "Dundee",
        "latitude": 49.1,
        "longitude": -122.2,
        "timeZone": "America/Vancouver",
    }
    first, second = document["hours"]
    assert [first["validAt"], second["validAt"]] == [
        "2026-08-09T13:00:00Z",
        "2026-08-09T14:00:00Z",
    ]
    assert first["pm25Ugm3"] == pytest.approx(25.0)  # 2.5e-8 kg/m³ → µg/m³
    assert first["smokePlumeSurfaceUgm3"] == pytest.approx(15.0)
    assert first["smokePlumeColumnMgm2"] == pytest.approx(5.0)  # 5e-6 kg/m² → mg/m²
