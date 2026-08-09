from __future__ import annotations

import copy
import hashlib
import json
import shutil
import statistics
from pathlib import Path

import pytest

from windgram import scenarios
from windgram.ensemble import circular_median
from windgram.scenarios import ScenarioCheckError, check_repository, generate_repository

ROOT = Path(__file__).resolve().parents[1]
ENSEMBLE_IDS = (
    "ensemble-tight",
    "ensemble-wide",
    "ensemble-column-censored",
)
PERCENTILE_KEYS = ("p10", "p25", "p50", "p75", "p90")


def load_json(path: Path) -> dict:
    return json.loads(path.read_text())


def definition(scenario_id: str) -> dict:
    return load_json(ROOT / "scenarios" / "definitions" / f"{scenario_id}.json")


def generated(scenario_id: str) -> dict:
    return load_json(ROOT / "scenarios" / "generated" / f"{scenario_id}.profile.json")


def percentile_blocks(value, path: str = ""):
    if isinstance(value, dict):
        if all(key in value for key in ("members", *PERCENTILE_KEYS)):
            yield path, value
            return
        for key, item in value.items():
            yield from percentile_blocks(item, f"{path}.{key}" if path else key)
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from percentile_blocks(item, f"{path}[{index}]")


def scenario_repository(tmp_path: Path) -> Path:
    shutil.copytree(ROOT / "scenarios", tmp_path / "scenarios")
    (tmp_path / "packages" / "windgram").mkdir(parents=True)
    shutil.copytree(
        ROOT / "packages" / "windgram" / "schema",
        tmp_path / "packages" / "windgram" / "schema",
    )
    (tmp_path / "data").mkdir()
    shutil.copy(ROOT / "data" / "models.json", tmp_path / "data" / "models.json")
    return tmp_path


def member_profiles(scenario_definition: dict) -> list[dict]:
    baseline = scenarios._load_baseline(scenario_definition, ROOT)
    source = scenarios._prepare_source(scenario_definition, baseline)
    scenarios._apply_transforms(scenario_definition, source)
    members = []
    for member_index in range(scenario_definition["ensemble"]["members"]):
        member_source = copy.deepcopy(source)
        scenarios._apply_member_perturbations(
            scenario_definition, member_source, member_index
        )
        scenarios._validate_source(scenario_definition, member_source)
        members.append(
            scenarios.derive_windgram_profile(
                member_source,
                model=scenario_definition["id"],
                semantics=scenario_definition["semantics"],
            )
        )
    return members


def test_each_member_is_derived_independently_before_the_production_aggregate(
    monkeypatch,
):
    recipe = definition("ensemble-tight")
    derivation = scenarios.derive_windgram_profile
    aggregation = scenarios.aggregate_member_profiles
    derived_profiles = []
    aggregated_inputs = []
    source_documents = []

    def recording_derivation(
        source: dict, model: str, semantics: dict[str, str]
    ) -> dict:
        source_documents.append(copy.deepcopy(source))
        profile = derivation(source, model, semantics)
        derived_profiles.append(profile)
        return profile

    def recording_aggregation(profiles: list[dict], **options) -> list[dict]:
        aggregated_inputs.append(list(profiles))
        return aggregation(profiles, **options)

    monkeypatch.setattr(scenarios, "derive_windgram_profile", recording_derivation)
    monkeypatch.setattr(scenarios, "aggregate_member_profiles", recording_aggregation)

    profile = scenarios.generate_scenario(recipe, repository_root=ROOT)

    assert profile == generated("ensemble-tight")
    assert len(source_documents) == recipe["ensemble"]["members"]
    assert all("derived" not in source for source in source_documents)
    assert all(
        "derived" not in hour
        for source in source_documents
        for hour in source["hours"]
    )
    assert len({json.dumps(source, sort_keys=True) for source in source_documents}) > 1
    assert aggregated_inputs == [derived_profiles]
    assert profile["run"]["members"] == recipe["ensemble"]["members"]
    assert profile["semantics"] == recipe["semantics"]


def test_member_sources_repeat_for_the_declared_seed_and_change_with_the_seed():
    recipe = definition("ensemble-wide")

    first = member_profiles(recipe)
    second = member_profiles(recipe)
    changed = copy.deepcopy(recipe)
    changed["clock"]["seed"] += 1
    third = member_profiles(changed)

    assert first == second
    assert first != third


def test_conditional_derived_members_are_a_valid_subset_of_the_ensemble():
    recipe = definition("ensemble-tight")
    heat_flux = recipe["ensemble"]["perturbations"][2]
    heat_flux.update(
        distribution="symmetric",
        spread=250,
        correlation="whole-column",
    )

    profile = scenarios.generate_scenario(recipe, repository_root=ROOT)
    conditional_counts = [
        hour["derived"]["usableLiftTopM"]["members"]
        for hour in profile["hours"]
    ]

    assert all(
        0 < count <= recipe["ensemble"]["members"]
        for count in conditional_counts
    )
    assert any(count < recipe["ensemble"]["members"] for count in conditional_counts)
    for path, block in percentile_blocks(profile["hours"]):
        if "derived.usableLiftTopM" not in path:
            assert block["members"] == recipe["ensemble"]["members"], path


@pytest.mark.parametrize("scenario_id", ENSEMBLE_IDS)
def test_percentile_order_and_member_count_hold_at_every_numeric_position(
    scenario_id: str,
):
    recipe = definition(scenario_id)
    blocks = list(percentile_blocks(generated(scenario_id)["hours"]))

    assert blocks
    for path, block in blocks:
        assert block["members"] == recipe["ensemble"]["members"], path
        values = [block[key] for key in PERCENTILE_KEYS]
        assert values == sorted(values), path
        assert block.get("ceiledMembers", 0) <= block["members"], path


def test_only_the_controlled_column_scenario_contains_censored_members():
    uncensored = {
        scenario_id: [
            (path, block["ceiledMembers"])
            for path, block in percentile_blocks(generated(scenario_id)["hours"])
            if block.get("ceiledMembers", 0)
        ]
        for scenario_id in ("ensemble-tight", "ensemble-wide")
    }
    censored = [
        (path, block["ceiledMembers"])
        for path, block in percentile_blocks(
            generated("ensemble-column-censored")["hours"]
        )
        if block.get("ceiledMembers", 0)
    ]

    assert uncensored == {"ensemble-tight": [], "ensemble-wide": []}
    assert censored
    assert all("derived.boundaryLayerTopM" in path for path, _ in censored)
    assert all(count == 9 for _, count in censored)


def test_tight_and_wide_scenarios_teach_materially_different_spread():
    tight = generated("ensemble-tight")["hours"][2]["surface"]["temperatureC"]
    wide = generated("ensemble-wide")["hours"][2]["surface"]["temperatureC"]

    tight_width = tight["p90"] - tight["p10"]
    wide_width = wide["p90"] - wide["p10"]

    assert tight_width < 1
    assert wide_width > 4
    assert wide_width > tight_width * 5


def test_wind_direction_uses_the_production_circular_median_across_north():
    recipe = definition("ensemble-tight")
    members = member_profiles(recipe)
    member_directions = [
        member["hours"][0]["surface"]["windDirectionDeg"] for member in members
    ]
    published = generated("ensemble-tight")["hours"][0]["surface"][
        "windDirectionDeg"
    ]

    assert min(member_directions) < 10
    assert max(member_directions) > 340
    assert published == round(circular_median(member_directions)) % 360
    assert published != round(statistics.median(member_directions)) % 360


def evaluate_ensemble_assertion(profile: dict, assertion: dict) -> None:
    scenarios._evaluate_assertions(
        {"id": "test-percentile-paths", "kind": "ensemble", "assertions": [assertion]},
        profile,
    )


def test_percentile_paths_resolve_numeric_positions_and_member_counts():
    profile = generated("ensemble-wide")

    evaluate_ensemble_assertion(
        profile,
        {
            "id": "band-is-wide",
            "actual": {"field": "surface.temperatureC.p90", "hour": 2},
            "operator": "absolute-difference-at-least",
            "expected": {"field": "surface.temperatureC.p10", "hour": 2},
            "threshold": 4,
        },
    )
    evaluate_ensemble_assertion(
        profile,
        {
            "id": "median-lift-is-above-terrain",
            "actual": {"field": "derived.usableLiftTopM.p50", "hour": 2},
            "operator": "greater-than",
            "expected": 900,
        },
    )
    evaluate_ensemble_assertion(
        profile,
        {
            "id": "member-count",
            "actual": {"field": "surface.temperatureC.members", "hour": 2},
            "operator": "equal",
            "expected": 9,
        },
    )

    present, value = scenarios._resolve_metric(
        profile, {"field": "derived.usableLiftTopM.p50", "hour": 2}
    )
    assert present
    assert value == profile["hours"][2]["derived"]["usableLiftTopM"]["p50"]


def test_nearest_height_selection_uses_the_median_height_of_ensemble_levels():
    profile = generated("ensemble-wide")
    hour = profile["hours"][2]
    level_800 = next(
        level for level in hour["levels"] if level["pressureHpa"] == 800
    )

    # Selecting near the 800 hPa median height must not attempt numeric
    # arithmetic on the percentile block (the pre-fix TypeError).
    present, value = scenarios._resolve_metric(
        profile,
        {
            "field": "levels.windSpeedMs.p50",
            "hour": 2,
            "level": {"nearestHeightM": level_800["heightM"]["p50"] + 40},
        },
    )

    assert present
    assert value == level_800["windSpeedMs"]["p50"]


def test_percentile_suffix_on_a_plain_number_raises_the_scenario_contract():
    ensemble = generated("ensemble-tight")
    deterministic = load_json(
        ROOT / "scenarios" / "generated" / "minimal-valid.profile.json"
    )

    for profile, field in (
        (ensemble, "surface.windDirectionDeg.p50"),
        (deterministic, "surface.temperatureC.p50"),
    ):
        with pytest.raises(
            scenarios.ScenarioAssertionError, match="not an ensemble percentile block"
        ):
            scenarios._resolve_metric(profile, {"field": field, "hour": 0})


def test_absent_optional_field_with_percentile_suffix_reports_absence():
    profile = generated("ensemble-tight")  # declares no CAPE capability

    present, value = scenarios._resolve_metric(
        profile, {"field": "surface.capeJkg.p50", "hour": 2}
    )
    assert (present, value) == (False, None)

    with pytest.raises(scenarios.ScenarioAssertionError, match="absent"):
        evaluate_ensemble_assertion(
            profile,
            {
                "id": "cape-band",
                "actual": {"field": "surface.capeJkg.p50", "hour": 2},
                "operator": "greater-than",
                "expected": 0,
            },
        )


def test_schema_keeps_the_percentile_path_vocabulary_closed():
    recipe = definition("ensemble-tight")
    recipe["assertions"] = [
        {
            "id": "valid-percentile-path",
            "description": "A trailing percentile key addresses one band position.",
            "actual": {"field": "derived.usableLiftTopM.p50", "hour": 2},
            "operator": "greater-than",
            "expected": 0,
        }
    ]
    scenarios.validate_definition(recipe, repository_root=ROOT)

    for field in ("surface.windDirectionDeg.p50", "derived.usableLiftTopM.p95"):
        rejected = copy.deepcopy(recipe)
        rejected["assertions"][0]["actual"]["field"] = field
        with pytest.raises(scenarios.ScenarioError, match="is invalid"):
            scenarios.validate_definition(rejected, repository_root=ROOT)


def test_declared_optional_surface_fields_are_aggregated_into_ensemble_hours():
    recipe = definition("ensemble-tight")
    recipe["capabilities"]["gust"] = "hourMax"
    recipe["semantics"]["gust"] = "hourMax"
    recipe["transforms"].append(
        {
            "type": "capability-field",
            "field": "surface.windGustMs",
            "action": "add",
            "value": 9,
        }
    )

    profile = scenarios.generate_scenario(recipe, repository_root=ROOT)

    assert profile["semantics"]["gust"] == "hourMax"
    for hour in profile["hours"]:
        block = hour["surface"]["windGustMs"]
        assert block["members"] == recipe["ensemble"]["members"]
        assert block["p10"] == block["p90"] == 9


def test_comparison_outputs_express_controlled_early_and_late_development():
    recipe = definition("model-timing-disagreement")
    earlier = load_json(
        ROOT
        / "scenarios"
        / "generated"
        / "model-timing-disagreement.earlier.profile.json"
    )
    later = load_json(
        ROOT
        / "scenarios"
        / "generated"
        / "model-timing-disagreement.later.profile.json"
    )

    assert [hour["validAt"] for hour in earlier["hours"]] == [
        hour["validAt"] for hour in later["hours"]
    ]
    assert (
        earlier["hours"][2]["derived"]["boundaryLayerTopM"]
        > later["hours"][2]["derived"]["boundaryLayerTopM"]
    )
    assert (
        later["hours"][5]["derived"]["thermalVelocityMs"]
        > earlier["hours"][5]["derived"]["thermalVelocityMs"]
    )
    language = json.dumps(recipe).lower()
    for prohibited in ("probability", "probabilities", "majority", "likelihood"):
        assert prohibited not in language


def test_index_hashes_every_ensemble_and_comparison_output():
    index = load_json(ROOT / "scenarios" / "index.json")
    entries = {entry["id"]: entry for entry in index["scenarios"]}

    assert set(ENSEMBLE_IDS).issubset(entries)
    comparison_outputs = entries["model-timing-disagreement"]["outputs"]
    assert [output["variant"] for output in comparison_outputs] == [
        "earlier",
        "later",
    ]
    for scenario_id in (*ENSEMBLE_IDS, "model-timing-disagreement"):
        for output in entries[scenario_id]["outputs"]:
            payload = (ROOT / "scenarios" / output["path"]).read_bytes()
            assert output["sha256"] == hashlib.sha256(payload).hexdigest()


def test_generate_check_and_double_hash_cover_multi_output_scenarios(tmp_path: Path):
    repository = scenario_repository(tmp_path)

    generate_repository(repository_root=repository)
    first_hashes = {
        path.name: hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted((repository / "scenarios" / "generated").glob("*.profile.json"))
    }
    first_index = (repository / "scenarios" / "index.json").read_bytes()
    generate_repository(repository_root=repository)

    assert {
        path.name: hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted((repository / "scenarios" / "generated").glob("*.profile.json"))
    } == first_hashes
    assert (repository / "scenarios" / "index.json").read_bytes() == first_index
    check_repository(repository_root=repository)

    stale = (
        repository
        / "scenarios"
        / "generated"
        / "model-timing-disagreement.later.profile.json"
    )
    stale.write_text("{}\n")
    with pytest.raises(ScenarioCheckError, match="model-timing-disagreement.later"):
        check_repository(repository_root=repository)

    generate_repository(repository_root=repository)
    check_repository(repository_root=repository)
