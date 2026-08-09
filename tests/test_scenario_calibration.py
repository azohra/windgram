from __future__ import annotations

import json
from pathlib import Path

import pytest

from windgram.windgram import derive_windgram_profile


ROOT = Path(__file__).resolve().parents[1]
BASELINE_PATH = (
    ROOT / "scenarios" / "baselines" / "hrrr-red-mountain-2026-08-08.source.json"
)
PROVENANCE_PATH = (
    ROOT / "scenarios" / "baselines" / "hrrr-red-mountain-2026-08-08.provenance.json"
)
ARCHIVED_PROFILE_PATH = ROOT / "site" / "src" / "components" / "research" / "forecast-example.json"

DERIVED_TOLERANCES = {
    "boundaryLayerTopM": ("derivedBoundaryLayerTopM", 6),
    "thermalVelocityMs": ("derivedThermalVelocityMs", 0.01),
    "cloudBaseM": ("derivedCloudBaseM", 52),
    "usableLiftTopM": ("derivedUsableLiftTopM", 52),
}

HRRR_SEMANTICS = {"gust": "instant", "precipitation": "instantRate"}

OPTIONAL_SURFACE_FIELDS = (
    "windGustMs",
    "capeJkg",
    "cinJkg",
    "pblHeightM",
    "lowCloudPercent",
    "midCloudPercent",
    "highCloudPercent",
)

SOURCE_TO_PUBLISHED_SURFACE = {
    "pressurePa": "pressurePa",
    "temperatureC": "temperatureC",
    "windSpeedMs": "windSpeedMs",
    "windDirectionDeg": "windDirectionDeg",
    "cloudCoverPercent": "cloudCoverPercent",
    "precipitationMm": "precipitationMmHr",
    "sensibleHeatFluxWm2": "sensibleHeatFluxWm2",
    "latentHeatFluxWm2": "latentHeatFluxWm2",
}

UNCHANGED_LEVEL_FIELDS = (
    "pressureHpa",
    "heightM",
    "temperatureC",
    "windSpeedMs",
    "windDirectionDeg",
)


def load_json(path: Path) -> dict:
    return json.loads(path.read_text())


def test_reconstructed_hrrr_baseline_preserves_teaching_relationships():
    source = load_json(BASELINE_PATH)
    provenance = load_json(PROVENANCE_PATH)
    archived = load_json(ARCHIVED_PROFILE_PATH)

    def contains_derived(value: object) -> bool:
        if isinstance(value, dict):
            return "derived" in value or any(contains_derived(child) for child in value.values())
        if isinstance(value, list):
            return any(contains_derived(child) for child in value)
        return False

    assert not contains_derived(source)
    assert len(source["hours"]) == len(archived["hours"]) == 10

    regenerated = derive_windgram_profile(
        source,
        model="hrrr-conus",
        semantics=HRRR_SEMANTICS,
    )
    assert regenerated["run"] == archived["run"]
    assert regenerated["site"] == archived["site"]
    assert regenerated["semantics"] == HRRR_SEMANTICS

    documented = provenance["numericTolerances"]
    for field, (tolerance_key, expected_tolerance) in DERIVED_TOLERANCES.items():
        assert documented[tolerance_key]["absolute"] == expected_tolerance

    for source_hour, regenerated_hour, archived_hour in zip(
        source["hours"], regenerated["hours"], archived["hours"], strict=True
    ):
        assert regenerated_hour["validAt"] == archived_hour["validAt"]

        for source_field, published_field in SOURCE_TO_PUBLISHED_SURFACE.items():
            assert source_hour[source_field] == archived_hour["surface"][published_field]
        for field in OPTIONAL_SURFACE_FIELDS:
            assert source_hour[field] == archived_hour["surface"][field]
            assert regenerated_hour["surface"][field] == archived_hour["surface"][field]

        assert regenerated_hour["surface"]["dewPointC"] == pytest.approx(
            archived_hour["surface"]["dewPointC"], abs=0.01
        )
        for source_level, regenerated_level, archived_level in zip(
            source_hour["levels"],
            regenerated_hour["levels"],
            archived_hour["levels"],
            strict=True,
        ):
            for field in UNCHANGED_LEVEL_FIELDS:
                assert source_level[field] == archived_level[field]
            assert regenerated_level["dewPointC"] == pytest.approx(
                archived_level["dewPointC"], abs=0.01
            )

        for field, (tolerance_key, _) in DERIVED_TOLERANCES.items():
            regenerated_value = regenerated_hour["derived"][field]
            archived_value = archived_hour["derived"][field]
            if archived_value is None:
                assert regenerated_value is None
            else:
                assert regenerated_value == pytest.approx(
                    archived_value, abs=documented[tolerance_key]["absolute"]
                )

    derived = [hour["derived"] for hour in regenerated["hours"]]
    assert [hour["boundaryLayerTopM"] for hour in derived[:6]] == sorted(
        hour["boundaryLayerTopM"] for hour in derived[:6]
    )
    assert derived[3]["thermalVelocityMs"] > derived[0]["thermalVelocityMs"]
    assert derived[6]["thermalVelocityMs"] < derived[3]["thermalVelocityMs"]
    assert all(hour["usableLiftTopM"] is not None for hour in derived[:7])
    assert all(hour["usableLiftTopM"] is None for hour in derived[7:])


def test_site_code_cannot_import_offline_calibration_baselines():
    code_suffixes = {
        ".astro",
        ".cjs",
        ".js",
        ".jsx",
        ".mdx",
        ".mjs",
        ".svelte",
        ".ts",
        ".tsx",
        ".vue",
    }
    forbidden_fragments = {
        "scenarios/baselines",
        "hrrr-red-mountain-2026-08-08.source.json",
        "hrrr-red-mountain-2026-08-08.provenance.json",
    }
    ignored_parts = {".astro", "dist", "node_modules"}
    offenders: list[str] = []

    for path in (ROOT / "site").rglob("*"):
        if not path.is_file() or path.suffix not in code_suffixes:
            continue
        if ignored_parts.intersection(path.relative_to(ROOT / "site").parts):
            continue
        text = path.read_text()
        if any(fragment in text for fragment in forbidden_fragments):
            offenders.append(str(path.relative_to(ROOT)))

    assert offenders == [], f"site code references offline calibration material: {offenders}"
