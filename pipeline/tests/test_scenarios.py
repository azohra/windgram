from __future__ import annotations

import copy
import hashlib
import json
import shutil
from datetime import datetime
from pathlib import Path

import pytest

from windgram import scenarios
from windgram.scenarios import (
    ScenarioAssertionError,
    ScenarioCheckError,
    ScenarioError,
    check_repository,
    generate_repository,
    generate_scenario,
    validate_definition,
)

# pipeline/tests/ — two parents up is the repository root above pipeline/.
ROOT = Path(__file__).resolve().parents[2]

WG_140_SCENARIOS = (
    "convective-cycle",
    "morning-inversion-erodes",
    "persistent-inversion",
    "cloud-base-limits-lift",
    "shear-through-lift-band",
    "gusts-after-heating",
    "front-arrival",
    "cape-under-cap",
    "missing-versus-zero",
    "three-hourly-sampling",
)


def load_json(path: Path) -> dict:
    return json.loads(path.read_text())


def minimal_definition() -> dict:
    return load_json(ROOT / "scenarios" / "definitions" / "minimal-valid.json")


def minimal_baseline() -> dict:
    return load_json(ROOT / "scenarios" / "baselines" / "minimal-hourly-core.source.json")


def scenario_repository(tmp_path: Path) -> Path:
    shutil.copytree(ROOT / "scenarios", tmp_path / "scenarios")
    (tmp_path / "toolkit").mkdir(parents=True)
    shutil.copytree(
        ROOT / "toolkit" / "schema",
        tmp_path / "toolkit" / "schema",
    )
    (tmp_path / "data").mkdir()
    shutil.copy(ROOT / "data" / "models.json", tmp_path / "data" / "models.json")
    return tmp_path


def test_wg_110_valid_fixture_validates():
    validate_definition(minimal_definition(), repository_root=ROOT)


@pytest.mark.parametrize(
    "fixture",
    [
        "missing-lesson.json",
        "unknown-transform.json",
        "invalid-clock.json",
        "direct-derived-authorship.json",
    ],
)
def test_every_wg_110_invalid_fixture_is_rejected(fixture: str):
    definition = load_json(ROOT / "scenarios" / "definitions" / "invalid" / fixture)

    with pytest.raises(ScenarioError, match="is invalid"):
        validate_definition(definition, repository_root=ROOT, source=fixture)


def test_semantic_validation_rejects_duplicate_schedule_hours_and_inverted_bands():
    definition = minimal_definition()
    definition["transforms"] = [
        {
            "type": "temperature-offset",
            "altitudeBandM": {"bottomM": 2000, "topM": 1000},
            "offsetC": {
                "byHour": [
                    {"hourOffset": 0, "value": 1},
                    {"hourOffset": 0, "value": 2},
                ]
            },
        }
    ]

    with pytest.raises(ScenarioError, match="topM must be greater"):
        validate_definition(definition, repository_root=ROOT)

    definition["transforms"][0]["altitudeBandM"] = {"bottomM": 1000, "topM": 2000}
    with pytest.raises(ScenarioError, match="duplicate hour offsets"):
        validate_definition(definition, repository_root=ROOT)


def test_semantic_validation_rejects_production_model_identity():
    definition = minimal_definition()
    definition["id"] = "gfs"

    with pytest.raises(ScenarioError, match="production model slug"):
        validate_definition(definition, repository_root=ROOT)


def test_generation_calls_the_authoritative_derivation_and_rounding(monkeypatch):
    definition = minimal_definition()
    calls = []
    authority = scenarios.derive_windgram_profile

    def recording_authority(source: dict, model: str, semantics: dict[str, str]) -> dict:
        calls.append((copy.deepcopy(source), model, semantics))
        return authority(source, model, semantics)

    monkeypatch.setattr(scenarios, "derive_windgram_profile", recording_authority)

    profile = generate_scenario(definition, repository_root=ROOT)

    assert len(calls) == 1
    assert calls[0][1] == "minimal-valid"
    assert calls[0][2] == {"precipitation": "instantRate"}
    assert calls[0][0]["siteTimeZone"] == definition["timeZone"]
    assert "derived" not in calls[0][0]
    assert all("derived" not in hour for hour in calls[0][0]["hours"])
    assert [hour["surface"]["temperatureC"] for hour in profile["hours"]] == [10, 12]
    assert profile["hours"][1]["derived"]["thermalVelocityMs"] == 1.44
    assert profile["hours"][1]["surface"]["windDirectionDeg"] == 240
    assert profile["semantics"] == definition["semantics"]
    assert profile["site"]["timeZone"] == definition["timeZone"]


def test_gust_transport_semantics_must_match_the_declared_capability():
    definition = minimal_definition()
    definition["modelShape"] = "three-hourly-regional"
    definition["clock"]["stepHours"] = 3
    definition["capabilities"]["gust"] = "instant"
    definition["semantics"]["gust"] = "hourMax"

    with pytest.raises(ScenarioError, match="semantics.gust must exactly match"):
        validate_definition(definition, repository_root=ROOT)


def test_all_deterministic_source_transforms_are_explicit_and_repeatable():
    definition = minimal_definition()
    definition["transforms"] = [
        {
            "type": "surface-field-curve",
            "field": "temperatureC",
            "points": [
                {"hourOffset": 0, "value": 10},
                {"hourOffset": 1, "value": 14},
            ],
        },
        {
            "type": "temperature-offset",
            "altitudeBandM": {"bottomM": 1000, "topM": 1700},
            "offsetC": {"byHour": [{"hourOffset": 0, "value": 1}, {"hourOffset": 1, "value": 3}]},
        },
        {
            "type": "dew-point-depression-offset",
            "altitudeBandM": {"bottomM": 1000, "topM": 1200},
            "offsetC": -1,
        },
        {
            "type": "wind-speed-scale",
            "altitudeBandM": {"bottomM": 800, "topM": 1700},
            "factor": 2,
            "includeSurface": True,
        },
        {
            "type": "wind-direction-rotate",
            "altitudeBandM": {"bottomM": 800, "topM": 1200},
            "degrees": 150,
            "includeSurface": True,
        },
        {"type": "pressure-tendency", "paPerHour": -10},
        {
            "type": "capability-field",
            "field": "surface.windGustMs",
            "action": "add",
            "value": {"byHour": [{"hourOffset": 0, "value": 8}, {"hourOffset": 1, "value": 10}]},
        },
        {
            "type": "capability-field",
            "field": "surface.windGustMs",
            "action": "omit",
            "atHours": [1],
        },
        {"type": "time-shift", "hours": 3},
        {
            "type": "elevation-adjustment",
            "siteAltitudeDeltaM": 25,
            "modelElevationDeltaM": 50,
        },
    ]
    validate_definition(definition, repository_root=ROOT)
    first = scenarios._prepare_source(definition, minimal_baseline())
    second = copy.deepcopy(first)

    scenarios._apply_transforms(definition, first)
    scenarios._apply_transforms(definition, second)

    assert first == second
    assert first["referenceTime"] == "2000-01-01T09:00:00Z"
    assert first["hours"][0]["validAt"] == "2000-01-01T15:00:00Z"
    assert first["siteAltitudeM"] == 1075
    assert first["modelElevationM"] == 950
    assert [hour["temperatureC"] for hour in first["hours"]] == [10, 14]
    assert first["hours"][0]["levels"][0]["temperatureC"] == 9
    assert first["hours"][1]["levels"][1]["temperatureC"] == 7
    assert first["hours"][0]["levels"][0]["dewPointDepressionC"] == 4
    assert first["hours"][0]["windSpeedMs"] == 6
    assert first["hours"][0]["levels"][1]["windSpeedMs"] == 12
    assert first["hours"][0]["windDirectionDeg"] == 390
    assert first["hours"][0]["levels"][0]["windDirectionDeg"] == 395
    assert first["hours"][1]["pressurePa"] == 89970
    assert first["hours"][0]["windGustMs"] == 8
    assert "windGustMs" not in first["hours"][1]


@pytest.mark.parametrize(
    ("mutation", "message"),
    [
        (lambda source: source["hours"][1].update(validAt=source["hours"][0]["validAt"]), "chronological"),
        (lambda source: source["hours"][0].update(windSpeedMs=-1), "non-negative"),
        (lambda source: source["hours"][0].update(dewPointDepressionC=-1), "dew point exceeds"),
        (lambda source: source["hours"][0]["levels"][1].update(pressureHpa=950), "pressure must strictly decrease"),
    ],
)
def test_physical_and_structural_source_checks_are_actionable(mutation, message: str):
    definition = minimal_definition()
    source = scenarios._prepare_source(definition, minimal_baseline())
    mutation(source)

    with pytest.raises(ScenarioError, match=message):
        scenarios._validate_source(definition, source)


def test_controlled_supersaturation_requires_an_explicit_exception():
    definition = minimal_definition()
    source = scenarios._prepare_source(definition, minimal_baseline())
    source["hours"][0]["dewPointDepressionC"] = -0.25

    with pytest.raises(ScenarioError, match="controlled-supersaturation"):
        scenarios._validate_source(definition, source)

    definition["physicalExceptions"] = [
        {
            "type": "controlled-supersaturation",
            "reason": "Exercise noisy source values without permitting accidental supersaturation.",
        }
    ]
    validate_definition(definition, repository_root=ROOT)
    scenarios._validate_source(definition, source)


def test_capability_declarations_must_match_the_transformed_source():
    definition = minimal_definition()
    definition["capabilities"]["gust"] = "instant"
    source = scenarios._prepare_source(definition, minimal_baseline())

    with pytest.raises(ScenarioError, match="windGustMs presence"):
        scenarios._validate_source(definition, source)


def test_baselines_cannot_author_derived_values(tmp_path: Path):
    repository = scenario_repository(tmp_path)
    baseline_path = repository / "scenarios" / "baselines" / "minimal-hourly-core.source.json"
    baseline = load_json(baseline_path)
    baseline["hours"][0]["derived"] = {"thermalVelocityMs": 99}
    baseline_path.write_text(json.dumps(baseline))

    with pytest.raises(ScenarioError, match="authors derived values"):
        generate_scenario(minimal_definition(), repository_root=repository)


def test_assertion_failure_names_scenario_hour_field_relation_and_actual():
    definition = minimal_definition()
    definition["assertions"][0] = {
        "id": "impossible-temperature",
        "description": "The second hour must exceed an intentionally impossible temperature.",
        "actual": {"field": "surface.temperatureC", "hour": 1},
        "operator": "greater-than",
        "expected": 100,
    }

    with pytest.raises(ScenarioAssertionError) as raised:
        generate_scenario(definition, repository_root=ROOT)

    message = str(raised.value)
    assert "scenario minimal-valid" in message
    assert "hour 1" in message
    assert "surface.temperatureC" in message
    assert "greater-than 100" in message
    assert "actual 12" in message


def test_generation_is_byte_deterministic_and_index_hashes_the_output(tmp_path: Path):
    repository = scenario_repository(tmp_path)

    generate_repository(repository_root=repository)
    output = repository / "scenarios" / "generated" / "minimal-valid.profile.json"
    index_path = repository / "scenarios" / "index.json"
    first_output = output.read_bytes()
    first_index = index_path.read_bytes()
    generate_repository(repository_root=repository)

    assert output.read_bytes() == first_output
    assert index_path.read_bytes() == first_index
    index = load_json(index_path)
    minimal_entry = next(
        entry for entry in index["scenarios"] if entry["id"] == "minimal-valid"
    )
    assert minimal_entry["outputs"] == [
        {
            "path": "generated/minimal-valid.profile.json",
            "sha256": hashlib.sha256(first_output).hexdigest(),
        }
    ]
    check_repository(repository_root=repository)


def test_check_detects_stale_missing_and_unmanaged_generated_files(tmp_path: Path):
    repository = scenario_repository(tmp_path)
    generate_repository(repository_root=repository)
    output = repository / "scenarios" / "generated" / "minimal-valid.profile.json"
    output.write_text("{}\n")
    (output.parent / "old.profile.json").write_text("{}\n")

    with pytest.raises(ScenarioCheckError) as raised:
        check_repository(repository_root=repository)

    assert "stale scenarios/generated/minimal-valid.profile.json" in str(raised.value)
    assert "unmanaged scenarios/generated/old.profile.json" in str(raised.value)
    assert "windgram scenarios generate" in str(raised.value)

    generate_repository(repository_root=repository)
    assert not (output.parent / "old.profile.json").exists()
    check_repository(repository_root=repository)


def test_comparison_generation_directs_callers_to_multi_output_generation():
    definition = minimal_definition()
    definition["kind"] = "comparison"
    definition["comparison"] = {
        "variants": [
            {"id": "early", "title": "Earlier development"},
            {"id": "late", "title": "Later development"},
        ]
    }

    with pytest.raises(ScenarioError, match=r"use generate_repository\(\)"):
        generate_scenario(definition, repository_root=ROOT)


@pytest.mark.parametrize("scenario_id", WG_140_SCENARIOS)
def test_wg_140_scenarios_have_three_assertions_and_match_generated_artifacts(
    scenario_id: str,
):
    definition = load_json(
        ROOT / "scenarios" / "definitions" / f"{scenario_id}.json"
    )

    assert len(definition["assertions"]) >= 3
    assert definition["semantics"]["precipitation"] in {
        "instantRate",
        "windowMeanRate",
    }
    generated = generate_scenario(definition, repository_root=ROOT)
    committed = load_json(
        ROOT / "scenarios" / "generated" / f"{scenario_id}.profile.json"
    )
    assert generated == committed


def test_wg_140_convective_and_inversion_lessons_are_visible_in_derived_values():
    cycle = load_json(
        ROOT / "scenarios" / "generated" / "convective-cycle.profile.json"
    )
    eroding = load_json(
        ROOT / "scenarios" / "generated" / "morning-inversion-erodes.profile.json"
    )
    persistent = load_json(
        ROOT / "scenarios" / "generated" / "persistent-inversion.profile.json"
    )

    assert (
        cycle["hours"][5]["surface"]["sensibleHeatFluxWm2"]
        > cycle["hours"][0]["surface"]["sensibleHeatFluxWm2"]
    )
    assert (
        cycle["hours"][5]["derived"]["boundaryLayerTopM"]
        > cycle["hours"][0]["derived"]["boundaryLayerTopM"]
    )
    assert (
        cycle["hours"][5]["derived"]["boundaryLayerTopM"]
        > cycle["hours"][4]["derived"]["boundaryLayerTopM"]
    )
    assert (
        cycle["hours"][5]["derived"]["boundaryLayerTopM"]
        > cycle["hours"][6]["derived"]["boundaryLayerTopM"]
    )
    assert (
        cycle["hours"][5]["derived"]["usableLiftTopM"]
        > cycle["hours"][6]["derived"]["usableLiftTopM"]
    )
    assert [hour["derived"]["usableLiftTopM"] is None for hour in cycle["hours"]] == [
        True,
        True,
        True,
        True,
        False,
        False,
        False,
        True,
        True,
        True,
    ]
    assert [hour["derived"]["cloudBaseM"] for hour in cycle["hours"][:6]] == sorted(
        hour["derived"]["cloudBaseM"] for hour in cycle["hours"][:6]
    )
    assert (
        cycle["hours"][5]["derived"]["cloudBaseM"]
        > cycle["hours"][5]["derived"]["usableLiftTopM"]
        > cycle["hours"][5]["derived"]["boundaryLayerTopM"]
    )

    for index in (0, 9):
        hour = cycle["hours"][index]
        assert hour["levels"][0]["temperatureC"] > hour["surface"]["temperatureC"]

    first_subfreezing_heights = [
        next(
            level["heightM"]
            for level in hour["levels"]
            if level["temperatureC"] <= 0
        )
        for hour in cycle["hours"]
    ]
    assert first_subfreezing_heights[5] > first_subfreezing_heights[0]

    peak = cycle["hours"][5]
    assert peak["levels"][-1]["windSpeedMs"] - peak["surface"]["windSpeedMs"] >= 12
    assert (
        abs(
            peak["levels"][-1]["windDirectionDeg"]
            - peak["surface"]["windDirectionDeg"]
        )
        >= 100
    )
    assert [hour["surface"]["capeJkg"] for hour in cycle["hours"]] == [
        0,
        0,
        0,
        60,
        320,
        780,
        440,
        80,
        20,
        0,
    ]
    assert [hour["surface"]["cinJkg"] for hour in cycle["hours"]] == [
        -180,
        -160,
        -140,
        -90,
        -35,
        -5,
        -20,
        -70,
        -110,
        -160,
    ]
    assert (
        eroding["hours"][0]["derived"]["boundaryLayerTopM"]
        < eroding["site"]["altitudeM"]
    )
    assert (
        eroding["hours"][4]["derived"]["boundaryLayerTopM"]
        > eroding["site"]["altitudeM"]
    )
    assert persistent["hours"][4]["surface"]["sensibleHeatFluxWm2"] >= 300
    assert (
        persistent["hours"][4]["derived"]["boundaryLayerTopM"]
        < persistent["site"]["altitudeM"]
    )


def test_wg_140_cloud_shear_and_gust_lessons_are_visible_in_profile_values():
    cloud = load_json(
        ROOT / "scenarios" / "generated" / "cloud-base-limits-lift.profile.json"
    )
    shear = load_json(
        ROOT / "scenarios" / "generated" / "shear-through-lift-band.profile.json"
    )
    gusts = load_json(
        ROOT / "scenarios" / "generated" / "gusts-after-heating.profile.json"
    )

    cloudy_hour = cloud["hours"][3]
    assert (
        cloudy_hour["derived"]["boundaryLayerTopM"]
        > cloudy_hour["derived"]["cloudBaseM"]
    )
    assert (
        cloudy_hour["derived"]["usableLiftTopM"]
        == cloudy_hour["derived"]["cloudBaseM"]
    )

    shear_hour = shear["hours"][3]
    upper = next(level for level in shear_hour["levels"] if level["pressureHpa"] == 700)
    assert shear_hour["derived"]["usableLiftTopM"] > upper["heightM"]
    assert upper["windSpeedMs"] - shear_hour["surface"]["windSpeedMs"] >= 10
    assert (
        abs(upper["windDirectionDeg"] - shear_hour["surface"]["windDirectionDeg"])
        >= 80
    )

    assert (
        gusts["hours"][6]["derived"]["thermalVelocityMs"]
        < gusts["hours"][2]["derived"]["thermalVelocityMs"]
    )
    assert gusts["hours"][6]["surface"]["windGustMs"] >= 8


def test_wg_140_front_cape_and_missing_value_lessons_are_visible():
    front = load_json(
        ROOT / "scenarios" / "generated" / "front-arrival.profile.json"
    )
    cape = load_json(
        ROOT / "scenarios" / "generated" / "cape-under-cap.profile.json"
    )
    missing = load_json(
        ROOT / "scenarios" / "generated" / "missing-versus-zero.profile.json"
    )

    assert (
        front["hours"][3]["surface"]["pressurePa"]
        < front["hours"][0]["surface"]["pressurePa"]
    )
    assert (
        front["hours"][6]["surface"]["cloudCoverPercent"]
        > front["hours"][2]["surface"]["cloudCoverPercent"]
    )
    assert (
        front["hours"][7]["surface"]["windSpeedMs"]
        > front["hours"][3]["surface"]["windSpeedMs"]
    )
    assert front["hours"][4]["surface"]["precipitationMmHr"] == 0
    assert front["hours"][8]["surface"]["precipitationMmHr"] > 0

    assert (
        cape["hours"][4]["surface"]["capeJkg"]
        > cape["hours"][0]["surface"]["capeJkg"]
    )
    assert cape["hours"][4]["surface"]["cinJkg"] <= -100
    assert cape["hours"][6]["surface"]["cinJkg"] > cape["hours"][4]["surface"]["cinJkg"]

    dry_surface = missing["hours"][2]["surface"]
    assert "windGustMs" not in dry_surface
    assert "precipitationMmHr" in dry_surface
    assert dry_surface["precipitationMmHr"] == 0


def test_wg_140_three_hourly_profile_has_only_source_cadence_samples():
    profile = load_json(
        ROOT / "scenarios" / "generated" / "three-hourly-sampling.profile.json"
    )
    instants = [
        datetime.fromisoformat(hour["validAt"].replace("Z", "+00:00"))
        for hour in profile["hours"]
    ]

    assert len(instants) == 6
    assert all(
        (later - earlier).total_seconds() == 3 * 60 * 60
        for earlier, later in zip(instants, instants[1:])
    )
