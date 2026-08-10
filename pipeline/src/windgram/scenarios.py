"""Deterministic, repository-local synthetic scenario generation.

Scenario definitions are recipes over source-shaped atmospheric columns.  This
module validates those recipes, applies only declared source transforms, and
then calls the production derivation and publication-rounding authorities.  A
generated profile is therefore reproducible teaching data, never a forecast
and never a second implementation of the derived quantities.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import random
import sys
from collections.abc import Iterable, Mapping
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker
from jsonschema.exceptions import ValidationError, best_match

from .derive import derive_windgram_profile
from .ensemble import aggregate_member_profiles
from .publish import round_document

# pipeline/src/windgram/scenarios.py — three parents up from the package is
# the checkout root above pipeline/.
REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
_MISSING = object()

_SURFACE_OPTIONAL_CAPABILITIES = {
    "surface.windGustMs": "gust",
    "surface.capeJkg": "cape",
    "surface.cinJkg": "cin",
    "surface.pblHeightM": "pblHeight",
}
_CLOUD_LAYER_FIELDS = ("lowCloudPercent", "midCloudPercent", "highCloudPercent")
_BASE_SOURCE_FIELDS = (
    "pressurePa",
    "temperatureC",
    "dewPointDepressionC",
    "windSpeedMs",
    "windDirectionDeg",
    "cloudCoverPercent",
    "precipitationMm",
    "sensibleHeatFluxWm2",
    "latentHeatFluxWm2",
    "levels",
)
_BASE_LEVEL_FIELDS = (
    "pressureHpa",
    "heightM",
    "temperatureC",
    "dewPointDepressionC",
    "windSpeedMs",
    "windDirectionDeg",
)
_ENSEMBLE_SURFACE_SCALARS = (
    "pressurePa",
    "temperatureC",
    "dewPointC",
    "windSpeedMs",
    "windDirectionDeg",
    "cloudCoverPercent",
    "precipitationMmHr",
    "sensibleHeatFluxWm2",
    "latentHeatFluxWm2",
)
_PERCENTILE_KEYS = ("p10", "p25", "p50", "p75", "p90")
_PERCENTILE_PATH_KEYS = (*_PERCENTILE_KEYS, "members")


class ScenarioError(ValueError):
    """A scenario cannot be validated or generated."""


class ScenarioCheckError(ScenarioError):
    """Committed generated artifacts do not match their recipes."""


class ScenarioAssertionError(ScenarioError):
    """A generated profile does not demonstrate its declared lesson."""


def _reject_json_constant(value: str) -> None:
    raise ScenarioError(f"JSON contains the non-finite value {value}")


def _load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(), parse_constant=_reject_json_constant)
    except OSError as error:
        raise ScenarioError(f"cannot read {path}: {error}") from error
    except json.JSONDecodeError as error:
        raise ScenarioError(f"invalid JSON in {path}: {error}") from error


def _json_bytes(value: Any) -> bytes:
    return (json.dumps(value, allow_nan=False, indent=2) + "\n").encode()


def _pointer(path: Iterable[Any]) -> str:
    parts = [str(part).replace("~", "~0").replace("/", "~1") for part in path]
    return "/" + "/".join(parts) if parts else "/"


def _schema_error_lines(errors: Iterable[ValidationError]) -> list[str]:
    selected = [best_match([error]) for error in errors]
    unique: dict[tuple[str, str], None] = {}
    for error in sorted(selected, key=lambda item: (_pointer(item.absolute_path), item.message)):
        unique[(_pointer(error.absolute_path), error.message)] = None
    return [f"{path}: {message}" for path, message in list(unique)[:12]]


def _validator(schema_path: Path) -> Draft202012Validator:
    schema = _load_json(schema_path)
    try:
        Draft202012Validator.check_schema(schema)
    except Exception as error:  # pragma: no cover - repository contract failure
        raise ScenarioError(f"invalid JSON Schema {schema_path}: {error}") from error
    return Draft202012Validator(schema, format_checker=FormatChecker())


def validate_definition(
    definition: Mapping[str, Any],
    *,
    repository_root: Path = REPOSITORY_ROOT,
    source: str = "scenario definition",
) -> None:
    """Validate the JSON Schema plus repository- and clock-dependent rules."""
    schema_path = repository_root / "scenarios" / "scenario.schema.json"
    errors = list(_validator(schema_path).iter_errors(definition))
    if errors:
        details = "\n  ".join(_schema_error_lines(errors))
        raise ScenarioError(f"{source} is invalid:\n  {details}")

    scenario_id = definition["id"]
    models = _load_json(repository_root / "models.json")
    model_slugs = {model["slug"] for model in models["models"]}
    if scenario_id in model_slugs:
        raise ScenarioError(
            f"scenario {scenario_id}: id is a production model slug; use a synthetic identity"
        )

    gust_capability = definition["capabilities"]["gust"]
    gust_semantics = definition["semantics"].get("gust")
    expected_gust_semantics = gust_capability if gust_capability is not False else None
    if gust_semantics != expected_gust_semantics:
        raise ScenarioError(
            f"scenario {scenario_id}: semantics.gust must exactly match capabilities.gust"
        )

    smoke_capability = definition["capabilities"].get("smoke", False)
    smoke_semantics = definition["semantics"].get("smoke")
    expected_smoke_semantics = smoke_capability if smoke_capability is not False else None
    if smoke_semantics != expected_smoke_semantics:
        raise ScenarioError(
            f"scenario {scenario_id}: semantics.smoke must exactly match capabilities.smoke"
        )

    hour_count = definition["clock"]["hourCount"]
    kind = definition["kind"]
    variants = definition.get("comparison", {}).get("variants", [])
    variant_ids = {variant["id"] for variant in variants}
    if len(variant_ids) != len(variants):
        raise ScenarioError(f"scenario {scenario_id}: comparison variant ids must be unique")
    for index, transform in enumerate(definition["transforms"]):
        label = f"scenario {scenario_id} transform {index} ({transform['type']})"
        target = transform.get("target")
        if kind == "comparison":
            if target is not None and target not in variant_ids:
                raise ScenarioError(f"{label}: unknown comparison target {target!r}")
        elif target is not None:
            raise ScenarioError(f"{label}: target is valid only for comparison scenarios")

        if "altitudeBandM" in transform:
            band = transform["altitudeBandM"]
            if band["topM"] <= band["bottomM"]:
                raise ScenarioError(
                    f"{label}: altitudeBandM.topM must be greater than bottomM"
                )
        if "atHours" in transform:
            _validate_hour_offsets(transform["atHours"], hour_count, f"{label}.atHours")
        if "points" in transform:
            _validate_points(transform["points"], hour_count, f"{label}.points")
        for name in ("offsetC", "factor", "degrees", "value"):
            scheduled = transform.get(name)
            if isinstance(scheduled, dict):
                _validate_points(scheduled["byHour"], hour_count, f"{label}.{name}.byHour")

    for assertion in definition["assertions"]:
        references = [assertion["actual"]]
        if isinstance(assertion.get("expected"), dict):
            references.append(assertion["expected"])
        for reference in references:
            target = reference.get("target")
            label = f"scenario {scenario_id} assertion {assertion['id']}"
            if kind == "comparison":
                if target not in variant_ids:
                    raise ScenarioError(
                        f"{label}: comparison metric reference must target a known variant"
                    )
            elif target is not None:
                raise ScenarioError(
                    f"{label}: target is valid only for comparison scenarios"
                )


def _validate_hour_offsets(offsets: Iterable[int], hour_count: int, label: str) -> None:
    offsets = list(offsets)
    duplicates = sorted({offset for offset in offsets if offsets.count(offset) > 1})
    if duplicates:
        raise ScenarioError(f"{label}: duplicate hour offsets {duplicates}")
    outside = [offset for offset in offsets if offset >= hour_count]
    if outside:
        raise ScenarioError(
            f"{label}: hour offsets {outside} exceed clock.hourCount {hour_count}"
        )


def _validate_points(points: Iterable[Mapping[str, Any]], hour_count: int, label: str) -> None:
    _validate_hour_offsets([point["hourOffset"] for point in points], hour_count, label)


def _contains_key(value: Any, prohibited: str) -> bool:
    if isinstance(value, dict):
        return prohibited in value or any(_contains_key(item, prohibited) for item in value.values())
    if isinstance(value, list):
        return any(_contains_key(item, prohibited) for item in value)
    return False


def _require_fields(value: Mapping[str, Any], fields: Iterable[str], label: str) -> None:
    missing = [field for field in fields if field not in value]
    if missing:
        raise ScenarioError(f"{label}: missing required source fields {missing}")


def _utc(value: str, label: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ScenarioError(f"{label}: invalid UTC instant {value!r}") from error
    if parsed.tzinfo is None or parsed.utcoffset() != timedelta(0):
        raise ScenarioError(f"{label}: instant must be UTC")
    return parsed.astimezone(timezone.utc)


def _utc_text(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _load_baseline(definition: Mapping[str, Any], repository_root: Path) -> dict[str, Any]:
    scenarios_root = repository_root / "scenarios"
    path = scenarios_root / definition["baseline"]["path"]
    try:
        path.resolve().relative_to(scenarios_root.resolve())
    except ValueError as error:  # schema also prevents this; keep the I/O boundary closed
        raise ScenarioError(f"scenario {definition['id']}: baseline escapes scenarios/") from error
    baseline = _load_json(path)
    if not isinstance(baseline, dict):
        raise ScenarioError(f"scenario {definition['id']}: baseline must be a JSON object")
    if _contains_key(baseline, "derived"):
        raise ScenarioError(
            f"scenario {definition['id']}: baseline {definition['baseline']['path']} authors derived values"
        )
    if "siteAltitudeM" in baseline:
        raise ScenarioError(
            f"scenario {definition['id']}: baseline {definition['baseline']['path']} "
            "carries siteAltitudeM — derivation inputs have been launch-agnostic "
            "since the launch decoupling: delete the field and declare the launch "
            "in the definition's launch block instead"
        )
    if definition["baseline"]["type"] == "calibrated":
        provenance = scenarios_root / definition["baseline"]["provenancePath"]
        if not provenance.is_file():
            raise ScenarioError(
                f"scenario {definition['id']}: calibrated baseline provenance is missing: {provenance}"
            )
        _load_json(provenance)
    return baseline


def _prepare_source(definition: Mapping[str, Any], baseline: Mapping[str, Any]) -> dict[str, Any]:
    scenario_id = definition["id"]
    _require_fields(
        baseline,
        (
            "referenceTime",
            "generatedAt",
            "siteId",
            "siteName",
            "latitude",
            "longitude",
            "modelElevationM",
            "hours",
        ),
        f"scenario {scenario_id} baseline",
    )
    baseline_hours = baseline["hours"]
    hour_count = definition["clock"]["hourCount"]
    if not isinstance(baseline_hours, list) or len(baseline_hours) != hour_count:
        count = len(baseline_hours) if isinstance(baseline_hours, list) else "non-array"
        raise ScenarioError(
            f"scenario {scenario_id}: baseline has {count} hours, expected clock.hourCount {hour_count}"
        )

    site = definition["site"]
    clock = definition["clock"]
    start = _utc(clock["startAt"], f"scenario {scenario_id} clock.startAt")
    step = timedelta(hours=clock["stepHours"])
    source = copy.deepcopy(dict(baseline))
    source.update(
        {
            "referenceTime": clock["referenceTime"],
            "generatedAt": clock["generatedAt"],
            "siteId": site["id"],
            "siteName": site["name"],
            "latitude": site["latitude"],
            "longitude": site["longitude"],
            "modelElevationM": site["modelElevationM"],
            "siteTimeZone": definition["timeZone"],
        }
    )
    for index, hour in enumerate(source["hours"]):
        if not isinstance(hour, dict):
            raise ScenarioError(f"scenario {scenario_id} baseline hour {index}: must be an object")
        hour["validAt"] = _utc_text(start + index * step)
    return source


def _scheduled_value(schedule: Any, hour: int) -> float:
    if not isinstance(schedule, dict):
        return float(schedule)
    points = sorted(schedule["byHour"], key=lambda point: point["hourOffset"])
    if hour <= points[0]["hourOffset"]:
        return float(points[0]["value"])
    if hour >= points[-1]["hourOffset"]:
        return float(points[-1]["value"])
    for below, above in zip(points, points[1:]):
        if below["hourOffset"] <= hour <= above["hourOffset"]:
            fraction = (hour - below["hourOffset"]) / (
                above["hourOffset"] - below["hourOffset"]
            )
            return float(below["value"] + fraction * (above["value"] - below["value"]))
    raise AssertionError("scheduled points did not bracket the validated hour")


def _selected(transform: Mapping[str, Any], hour: int) -> bool:
    return "atHours" not in transform or hour in transform["atHours"]


def _in_band(altitude_m: float, transform: Mapping[str, Any]) -> bool:
    band = transform["altitudeBandM"]
    return band["bottomM"] <= altitude_m <= band["topM"]


def _curve_value(points: Iterable[Mapping[str, Any]], hour: int) -> float:
    return _scheduled_value({"byHour": list(points)}, hour)


def _apply_transforms(definition: Mapping[str, Any], source: dict[str, Any]) -> None:
    for transform in definition["transforms"]:
        operation = transform["type"]
        if operation == "surface-field-curve":
            for index, hour in enumerate(source["hours"]):
                hour[transform["field"]] = _curve_value(transform["points"], index)
        elif operation in {
            "temperature-offset",
            "dew-point-depression-offset",
            "wind-speed-scale",
            "wind-direction-rotate",
        }:
            _apply_level_transform(transform, source)
        elif operation == "pressure-tendency":
            step_hours = definition["clock"]["stepHours"]
            for index, hour in enumerate(source["hours"]):
                hour["pressurePa"] += transform["paPerHour"] * index * step_hours
        elif operation == "capability-field":
            _apply_capability_field(transform, definition, source)
        elif operation == "time-shift":
            delta = timedelta(hours=transform["hours"])
            source["referenceTime"] = _utc_text(_utc(source["referenceTime"], "referenceTime") + delta)
            source["generatedAt"] = _utc_text(_utc(source["generatedAt"], "generatedAt") + delta)
            for hour in source["hours"]:
                hour["validAt"] = _utc_text(_utc(hour["validAt"], "validAt") + delta)
        elif operation == "elevation-adjustment":
            source["modelElevationM"] += transform["modelElevationDeltaM"]
        else:  # protected by the closed JSON Schema vocabulary
            raise AssertionError(f"unhandled validated transform {operation}")


def _definition_for_variant(
    definition: Mapping[str, Any], variant_id: str
) -> dict[str, Any]:
    """Return a recipe containing common transforms plus one variant's transforms."""
    selected = copy.deepcopy(dict(definition))
    selected["transforms"] = []
    for transform in definition["transforms"]:
        if transform.get("target") not in (None, variant_id):
            continue
        operation = copy.deepcopy(transform)
        operation.pop("target", None)
        selected["transforms"].append(operation)
    return selected


def _stable_random(seed: int, *coordinates: Any) -> random.Random:
    """Construct a reproducible scenario-local random stream."""
    material = json.dumps([seed, *coordinates], separators=(",", ":")).encode()
    integer_seed = int.from_bytes(hashlib.sha256(material).digest(), "big")
    return random.Random(integer_seed)


def _perturbation_group(
    correlation: str,
    *,
    hour_index: int,
    level: Mapping[str, Any] | None,
) -> str:
    if correlation == "whole-column":
        return "column"
    if correlation == "by-hour":
        return f"hour:{hour_index}"
    if correlation == "by-level":
        return (
            "surface"
            if level is None
            else f"level:{level['pressureHpa']}"
        )
    return (
        f"surface:{hour_index}"
        if level is None
        else f"level:{hour_index}:{level['pressureHpa']}"
    )


def _symmetric_coordinate(
    *,
    seed: int,
    perturbation_index: int,
    group: str,
    member_index: int,
    member_count: int,
) -> float:
    ranks = list(range(member_count))
    _stable_random(seed, "symmetric", perturbation_index, group).shuffle(ranks)
    rank = ranks[member_index]
    return -1.0 + 2.0 * rank / (member_count - 1)


def _perturbation_delta(
    perturbation: Mapping[str, Any],
    *,
    seed: int,
    perturbation_index: int,
    group: str,
    member_index: int,
    member_count: int,
) -> float:
    distribution = perturbation["distribution"]
    spread = perturbation["spread"]
    if distribution == "symmetric":
        coordinate = _symmetric_coordinate(
            seed=seed,
            perturbation_index=perturbation_index,
            group=group,
            member_index=member_index,
            member_count=member_count,
        )
    else:
        stream = _stable_random(
            seed, distribution, perturbation_index, group, member_index
        )
        coordinate = (
            stream.gauss(0.0, 1.0)
            if distribution == "normal"
            else stream.uniform(-1.0, 1.0)
        )
    return spread * coordinate


def _apply_member_perturbations(
    definition: Mapping[str, Any], source: dict[str, Any], member_index: int
) -> None:
    ensemble = definition["ensemble"]
    member_count = ensemble["members"]
    seed = definition["clock"]["seed"]
    for perturbation_index, perturbation in enumerate(ensemble["perturbations"]):
        block, field = perturbation["field"].split(".", 1)
        for hour_index, hour in enumerate(source["hours"]):
            containers = [hour] if block == "surface" else hour["levels"]
            for container in containers:
                group = _perturbation_group(
                    perturbation["correlation"],
                    hour_index=hour_index,
                    level=container if block == "levels" else None,
                )
                container[field] += _perturbation_delta(
                    perturbation,
                    seed=seed,
                    perturbation_index=perturbation_index,
                    group=group,
                    member_index=member_index,
                    member_count=member_count,
                )


def _apply_level_transform(transform: Mapping[str, Any], source: dict[str, Any]) -> None:
    operation = transform["type"]
    field, operand = {
        "temperature-offset": ("temperatureC", "offsetC"),
        "dew-point-depression-offset": ("dewPointDepressionC", "offsetC"),
        "wind-speed-scale": ("windSpeedMs", "factor"),
        "wind-direction-rotate": ("windDirectionDeg", "degrees"),
    }[operation]
    for index, hour in enumerate(source["hours"]):
        if not _selected(transform, index):
            continue
        amount = _scheduled_value(transform[operand], index)
        for level in hour["levels"]:
            if _in_band(level["heightM"], transform):
                level[field] = level[field] * amount if operation == "wind-speed-scale" else level[field] + amount
        if transform.get("includeSurface") and _in_band(source["modelElevationM"], transform):
            hour[field] = hour[field] * amount if operation == "wind-speed-scale" else hour[field] + amount


def _apply_capability_field(
    transform: Mapping[str, Any], definition: Mapping[str, Any], source: dict[str, Any]
) -> None:
    path = transform["field"]
    block, field = path.split(".", 1)
    vertical_levels = set(definition["capabilities"].get("verticalVelocityLevels", []))
    for index, hour in enumerate(source["hours"]):
        if not _selected(transform, index):
            continue
        containers = [hour] if block == "surface" else hour["levels"]
        for container in containers:
            if field == "verticalVelocityPaS" and container["pressureHpa"] not in vertical_levels:
                container.pop(field, None)
                continue
            if transform["action"] == "omit":
                container.pop(field, None)
            else:
                container[field] = _scheduled_value(transform["value"], index)


def _finite_number(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ScenarioError(f"{label}: expected a finite number, got {value!r}")
    return float(value)


def _controlled_supersaturation(definition: Mapping[str, Any]) -> bool:
    return any(
        exception["type"] == "controlled-supersaturation"
        for exception in definition.get("physicalExceptions", [])
    )


def _validate_source(definition: Mapping[str, Any], source: Mapping[str, Any]) -> None:
    scenario_id = definition["id"]
    model_elevation = _finite_number(
        source["modelElevationM"], f"scenario {scenario_id} model elevation"
    )
    previous_time: datetime | None = None
    allow_supersaturation = _controlled_supersaturation(definition)
    for hour_index, hour in enumerate(source["hours"]):
        label = f"scenario {scenario_id} hour {hour_index}"
        _require_fields(hour, _BASE_SOURCE_FIELDS, label)
        valid_at = _utc(hour["validAt"], f"{label}.validAt")
        if previous_time is not None and valid_at <= previous_time:
            raise ScenarioError(f"{label}: hours must be strictly chronological")
        previous_time = valid_at
        for field in _BASE_SOURCE_FIELDS[:-1]:
            _finite_number(hour[field], f"{label}.{field}")
        if hour["pressurePa"] <= 0:
            raise ScenarioError(f"{label}.pressurePa: pressure must be positive")
        if hour["windSpeedMs"] < 0:
            raise ScenarioError(f"{label}.windSpeedMs: wind speed must be non-negative")
        if hour["dewPointDepressionC"] < 0 and not allow_supersaturation:
            raise ScenarioError(
                f"{label}: dew point exceeds temperature; declare controlled-supersaturation to test this edge case"
            )
        if not isinstance(hour["levels"], list):
            raise ScenarioError(f"{label}.levels: expected an array")
        ordered = sorted(hour["levels"], key=lambda level: level.get("heightM", math.inf))
        previous_height: float | None = None
        previous_pressure: float | None = None
        for level_index, level in enumerate(ordered):
            level_label = f"{label} level {level_index}"
            _require_fields(level, _BASE_LEVEL_FIELDS, level_label)
            for field in _BASE_LEVEL_FIELDS:
                _finite_number(level[field], f"{level_label}.{field}")
            if level["windSpeedMs"] < 0:
                raise ScenarioError(f"{level_label}.windSpeedMs: wind speed must be non-negative")
            if level["dewPointDepressionC"] < 0 and not allow_supersaturation:
                raise ScenarioError(
                    f"{level_label}: dew point exceeds temperature; declare controlled-supersaturation to test this edge case"
                )
            if previous_height is not None and (
                level["heightM"] <= previous_height or level["pressureHpa"] >= previous_pressure
            ):
                raise ScenarioError(
                    f"{level_label}: pressure must strictly decrease as level height increases "
                    f"(previous {previous_pressure} hPa at {previous_height} m, actual "
                    f"{level['pressureHpa']} hPa at {level['heightM']} m)"
                )
            previous_height = level["heightM"]
            previous_pressure = level["pressureHpa"]
        if not any(level["heightM"] > model_elevation + 20 for level in ordered):
            raise ScenarioError(f"{label}: no pressure level remains above model terrain after filtering")
    _validate_capabilities(definition, source)


def _validate_capabilities(definition: Mapping[str, Any], source: Mapping[str, Any]) -> None:
    scenario_id = definition["id"]
    capabilities = definition["capabilities"]
    model_elevation = source["modelElevationM"]
    for hour_index, hour in enumerate(source["hours"]):
        label = f"scenario {scenario_id} hour {hour_index} capability"
        retained = [level for level in hour["levels"] if level["heightM"] > model_elevation + 20]
        expected_pressures = capabilities["pressureLevels"] if capabilities["levels"] else []
        actual_pressures = [
            level["pressureHpa"]
            for level in sorted(retained, key=lambda item: -item["pressureHpa"])
        ]
        if actual_pressures != expected_pressures:
            raise ScenarioError(
                f"{label}: declared pressureLevels {expected_pressures} do not match retained source levels {actual_pressures}"
            )
        if not capabilities["heatFluxes"]:
            raise ScenarioError(
                f"{label}: derive_windgram_profile requires heat-flux source fields; this shape cannot declare heatFluxes false"
            )
        for path, capability in _SURFACE_OPTIONAL_CAPABILITIES.items():
            field = path.split(".", 1)[1]
            expected = capabilities[capability] is not False
            if (field in hour) != expected:
                raise ScenarioError(f"{label}: {field} presence does not match capabilities.{capability}")
        for field in _CLOUD_LAYER_FIELDS:
            if (field in hour) != capabilities["cloudLayers"]:
                raise ScenarioError(f"{label}: {field} presence does not match capabilities.cloudLayers")
        if ("smoke" in hour) != (capabilities.get("smoke", False) is not False):
            raise ScenarioError(f"{label}: smoke presence does not match capabilities.smoke")
        vertical_expected = set(capabilities.get("verticalVelocityLevels", []))
        for level in retained:
            expected = capabilities["verticalVelocity"] is not False and level["pressureHpa"] in vertical_expected
            if ("verticalVelocityPaS" in level) != expected:
                raise ScenarioError(
                    f"{label}: verticalVelocityPaS presence at {level['pressureHpa']} hPa does not match capabilities"
                )
            if ("cloudFractionPercent" in level) != capabilities["cloudProfile"]:
                raise ScenarioError(
                    f"{label}: cloudFractionPercent presence at {level['pressureHpa']} hPa does not match capabilities.cloudProfile"
                )


def _validate_profile(
    definition: Mapping[str, Any], profile: Mapping[str, Any], repository_root: Path
) -> None:
    scenario_id = definition["id"]
    schema_path = repository_root / "toolkit" / "schema" / "profile.schema.json"
    errors = list(_validator(schema_path).iter_errors(profile))
    if errors:
        details = "\n  ".join(_schema_error_lines(errors))
        raise ScenarioError(f"scenario {scenario_id}: generated profile is contract-invalid:\n  {details}")
    if profile["model"] != scenario_id:
        raise ScenarioError(f"scenario {scenario_id}: generated profile has unexpected model identity")
    if profile.get("semantics") != definition["semantics"]:
        raise ScenarioError(
            f"scenario {scenario_id}: generated profile does not preserve declared transport semantics"
        )
    if definition["kind"] == "ensemble":
        if profile["run"].get("members") != definition["ensemble"]["members"]:
            raise ScenarioError(
                f"scenario {scenario_id}: generated run member count does not match the definition"
            )
        _validate_ensemble_profile(definition, profile)
        return
    if "members" in profile["run"]:
        raise ScenarioError(f"scenario {scenario_id}: deterministic run declares ensemble members")
    previous_time: datetime | None = None
    allow_supersaturation = _controlled_supersaturation(definition)
    model_elevation = profile["site"]["modelElevationM"]
    for hour_index, hour in enumerate(profile["hours"]):
        valid_at = _utc(hour["validAt"], f"scenario {scenario_id} hour {hour_index}.validAt")
        if previous_time is not None and valid_at <= previous_time:
            raise ScenarioError(f"scenario {scenario_id} hour {hour_index}: hours are not chronological")
        previous_time = valid_at
        surface = hour["surface"]
        if surface["windSpeedMs"] < 0 or not 0 <= surface["windDirectionDeg"] < 360:
            raise ScenarioError(
                f"scenario {scenario_id} hour {hour_index}: surface wind is not normalized and non-negative"
            )
        if surface["dewPointC"] > surface["temperatureC"] and not allow_supersaturation:
            raise ScenarioError(f"scenario {scenario_id} hour {hour_index}: surface dew point exceeds temperature")
        previous_height: float | None = None
        previous_pressure: float | None = None
        for level in hour["levels"]:
            if level["heightM"] <= model_elevation:
                raise ScenarioError(
                    f"scenario {scenario_id} hour {hour_index}: level at {level['heightM']} m is not above model terrain {model_elevation} m"
                )
            if previous_height is not None and (
                level["heightM"] <= previous_height or level["pressureHpa"] >= previous_pressure
            ):
                raise ScenarioError(
                    f"scenario {scenario_id} hour {hour_index}: pressure does not decrease with level height"
                )
            if level["windSpeedMs"] < 0 or not 0 <= level["windDirectionDeg"] < 360:
                raise ScenarioError(
                    f"scenario {scenario_id} hour {hour_index}: level wind is not normalized and non-negative"
                )
            if level["dewPointC"] > level["temperatureC"] and not allow_supersaturation:
                raise ScenarioError(f"scenario {scenario_id} hour {hour_index}: level dew point exceeds temperature")
            previous_height = level["heightM"]
            previous_pressure = level["pressureHpa"]
        if set(hour["derived"]) != {
            "boundaryLayerTopM",
            "thermalVelocityMs",
            "cloudBaseM",
            "usableLiftTopM",
        }:
            raise ScenarioError(f"scenario {scenario_id} hour {hour_index}: derived block is not authoritative")


def _percentile_blocks(value: Any, path: str = "") -> Iterable[tuple[str, Mapping[str, Any]]]:
    if isinstance(value, dict):
        if all(key in value for key in ("members", *_PERCENTILE_KEYS)):
            yield path, value
            return
        for key, item in value.items():
            yield from _percentile_blocks(item, f"{path}.{key}" if path else key)
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from _percentile_blocks(item, f"{path}[{index}]")


def _validate_ensemble_profile(
    definition: Mapping[str, Any], profile: Mapping[str, Any]
) -> None:
    scenario_id = definition["id"]
    declared_members = definition["ensemble"]["members"]
    blocks = list(_percentile_blocks(profile["hours"]))
    if not blocks:
        raise ScenarioError(f"scenario {scenario_id}: ensemble contains no percentile blocks")
    for path, block in blocks:
        contributors = block["members"]
        if not 0 <= contributors <= declared_members:
            raise ScenarioError(
                f"scenario {scenario_id}: {path} has {contributors} contributors, "
                f"outside the declared 0–{declared_members} member range"
            )
        values = [block[key] for key in _PERCENTILE_KEYS]
        if contributors == 0:
            ordered = all(value is None for value in values)
        else:
            ordered = all(value is not None for value in values) and values == sorted(
                values
            )
        if not ordered:
            raise ScenarioError(
                f"scenario {scenario_id}: percentile order fails at {path}: {values}"
            )
        if block.get("ceiledMembers", 0) > block["members"]:
            raise ScenarioError(
                f"scenario {scenario_id}: ceiledMembers exceeds members at {path}"
            )

    previous_time: datetime | None = None
    declared_optional = _declared_optional_surface_scalars(definition)
    for hour_index, hour in enumerate(profile["hours"]):
        valid_at = _utc(
            hour["validAt"], f"scenario {scenario_id} hour {hour_index}.validAt"
        )
        if previous_time is not None and valid_at <= previous_time:
            raise ScenarioError(
                f"scenario {scenario_id} hour {hour_index}: hours are not chronological"
            )
        previous_time = valid_at
        missing_optional = [
            field for field in declared_optional if field not in hour["surface"]
        ]
        if missing_optional:
            raise ScenarioError(
                f"scenario {scenario_id} hour {hour_index}: ensemble aggregate drops "
                f"declared optional surface fields {missing_optional}"
            )
        directions = [hour["surface"]["windDirectionDeg"]] + [
            level["windDirectionDeg"] for level in hour["levels"]
        ]
        if any(not 0 <= direction < 360 for direction in directions):
            raise ScenarioError(
                f"scenario {scenario_id} hour {hour_index}: ensemble wind direction is not normalized"
            )


def _level_height_position(level: Mapping[str, Any]) -> float:
    """A level's height for nearest-height selection.

    Deterministic levels publish a number; ensemble levels publish a
    percentile block, whose p50 is the position the aggregation itself
    orders levels by, so the median is the honest selection height.
    """
    height = level["heightM"]
    if isinstance(height, Mapping):
        height = height.get("p50")
    if isinstance(height, bool) or not isinstance(height, (int, float)):
        raise ScenarioAssertionError(
            f"level at {level.get('pressureHpa')!r} hPa has no numeric height position"
        )
    return float(height)


def _split_metric_field(field: str) -> tuple[str, str, str | None]:
    """Split a metric path into block, field name, and optional percentile key.

    A trailing `.p10/.p25/.p50/.p75/.p90/.members` names one position inside
    an ensemble percentile block; everything before it is the published field.
    """
    block, _, name = field.partition(".")
    head, _, tail = name.rpartition(".")
    if head and tail in _PERCENTILE_PATH_KEYS:
        return block, head, tail
    return block, name, None


def _resolve_metric(
    profile: Mapping[str, Any],
    reference: Mapping[str, Any],
    launch: Mapping[str, Any] | None = None,
) -> tuple[bool, Any]:
    field = reference["field"]
    block, name, percentile = _split_metric_field(field)
    if block == "launch":
        # The scenario's launch is definition metadata (published in the
        # index), never a document field — assertions that teach against it
        # read the recipe, not the generated profile.
        container = launch or {}
    elif block == "site":
        container = profile["site"]
    else:
        hour_index = reference["hour"]
        if hour_index >= len(profile["hours"]):
            raise ScenarioAssertionError(f"hour {hour_index} is outside generated profile")
        hour = profile["hours"][hour_index]
        if block in {"surface", "derived"}:
            container = hour[block]
        elif block == "smoke":
            # The optional per-hour block: an absent block reads as the
            # field being absent, the same statement the contract makes.
            container = hour.get("smoke", {})
        else:
            levels = hour["levels"]
            selector = reference["level"]
            if "pressureHpa" in selector:
                matches = [level for level in levels if level["pressureHpa"] == selector["pressureHpa"]]
                if not matches:
                    raise ScenarioAssertionError(
                        f"hour {hour_index} has no level at {selector['pressureHpa']} hPa"
                    )
                container = matches[0]
            else:
                if not levels:
                    raise ScenarioAssertionError(f"hour {hour_index} has no levels")
                container = min(
                    levels,
                    key=lambda level: abs(
                        _level_height_position(level) - selector["nearestHeightM"]
                    ),
                )
    present = name in container
    value = container.get(name)
    if percentile is None:
        return (present, value)
    if not present:
        return (False, None)
    if not isinstance(value, Mapping) or percentile not in value:
        raise ScenarioAssertionError(
            f"field {field}: {block}.{name} is not an ensemble percentile block"
        )
    return (True, value[percentile])


def _assertion_context(assertion: Mapping[str, Any]) -> str:
    reference = assertion["actual"]
    hour = reference.get("hour", "site")
    return f"hour {hour}, field {reference['field']}"


def _profile_for_reference(
    definition: Mapping[str, Any],
    profiles: Mapping[str, Any],
    reference: Mapping[str, Any],
) -> Mapping[str, Any]:
    if definition["kind"] != "comparison":
        return profiles
    return profiles[reference["target"]]


def _evaluate_assertions(definition: Mapping[str, Any], profiles: Mapping[str, Any]) -> None:
    scenario_id = definition["id"]
    operators = {
        "equal": lambda actual, expected, tolerance: abs(actual - expected) <= tolerance,
        "not-equal": lambda actual, expected, tolerance: abs(actual - expected) > tolerance,
        "greater-than": lambda actual, expected, tolerance: actual > expected + tolerance,
        "greater-than-or-equal": lambda actual, expected, tolerance: actual >= expected - tolerance,
        "less-than": lambda actual, expected, tolerance: actual < expected - tolerance,
        "less-than-or-equal": lambda actual, expected, tolerance: actual <= expected + tolerance,
    }
    launch = definition.get("launch")
    for assertion in definition["assertions"]:
        context = _assertion_context(assertion)
        try:
            profile = _profile_for_reference(
                definition, profiles, assertion["actual"]
            )
            present, actual = _resolve_metric(profile, assertion["actual"], launch)
        except ScenarioAssertionError as error:
            raise ScenarioAssertionError(
                f"scenario {scenario_id} assertion {assertion['id']} ({context}): {error}"
            ) from error
        operator = assertion["operator"]
        if operator in {"present", "absent"}:
            passed = present if operator == "present" else not present
            if not passed:
                raise ScenarioAssertionError(
                    f"scenario {scenario_id} assertion {assertion['id']} ({context}): "
                    f"expected {operator}, actual {actual!r}"
                )
            continue
        if not present:
            raise ScenarioAssertionError(
                f"scenario {scenario_id} assertion {assertion['id']} ({context}): "
                f"expected relation {operator}, actual field is absent"
            )
        expected_spec = assertion["expected"]
        if isinstance(expected_spec, dict):
            try:
                expected_profile = _profile_for_reference(
                    definition, profiles, expected_spec
                )
                expected_present, expected = _resolve_metric(
                    expected_profile, expected_spec, launch
                )
            except ScenarioAssertionError as error:
                raise ScenarioAssertionError(
                    f"scenario {scenario_id} assertion {assertion['id']} ({context}): "
                    f"expected reference: {error}"
                ) from error
            if not expected_present:
                raise ScenarioAssertionError(
                    f"scenario {scenario_id} assertion {assertion['id']} ({context}): expected field is absent"
                )
        else:
            expected = expected_spec
        if not isinstance(actual, (int, float)) or not isinstance(expected, (int, float)):
            raise ScenarioAssertionError(
                f"scenario {scenario_id} assertion {assertion['id']} ({context}): "
                f"expected numeric relation {operator}, actual {actual!r}, expected {expected!r}"
            )
        if operator == "absolute-difference-at-least":
            passed = abs(actual - expected) >= assertion["threshold"]
            expected_relation = f"absolute difference >= {assertion['threshold']} from {expected!r}"
        else:
            tolerance = assertion.get("tolerance", 0)
            passed = operators[operator](actual, expected, tolerance)
            expected_relation = f"{operator} {expected!r} (tolerance {tolerance})"
        if not passed:
            raise ScenarioAssertionError(
                f"scenario {scenario_id} assertion {assertion['id']} ({context}): "
                f"expected {expected_relation}, actual {actual!r}"
            )


def generate_scenario(
    definition: Mapping[str, Any], *, repository_root: Path = REPOSITORY_ROOT
) -> dict[str, Any]:
    """Generate one rounded, asserted profile for a non-comparison recipe."""
    if definition.get("kind") == "comparison":
        raise ScenarioError(
            f"scenario {definition.get('id', '<unknown>')}: comparison recipes produce "
            "multiple profiles; use generate_repository() or "
            "`windgram scenarios generate`"
        )
    validate_definition(
        definition,
        repository_root=repository_root,
        source=f"scenario {definition.get('id', '<unknown>')}",
    )
    if definition["kind"] == "ensemble":
        return _generate_ensemble_profile(definition, repository_root)
    profile = _generate_deterministic_profile(definition, repository_root)
    _evaluate_assertions(definition, profile)
    return profile


def _generate_deterministic_profile(
    definition: Mapping[str, Any], repository_root: Path
) -> dict[str, Any]:
    baseline = _load_baseline(definition, repository_root)
    source = _prepare_source(definition, baseline)
    _apply_transforms(definition, source)
    _validate_source(definition, source)
    profile = round_document(
        derive_windgram_profile(
            source,
            model=definition["id"],
            semantics=definition["semantics"],
        )
    )
    _validate_profile(definition, profile, repository_root)
    return profile


def _declared_optional_surface_scalars(definition: Mapping[str, Any]) -> tuple[str, ...]:
    """The optional surface fields the definition declares, in published order.

    An ensemble that declares a capability must publish the field's percentile
    block: the aggregate cannot echo `semantics.gust` while dropping
    `windGustMs` (the published contract ties them together).
    """
    capabilities = definition["capabilities"]
    declared = [
        path.split(".", 1)[1]
        for path, capability in _SURFACE_OPTIONAL_CAPABILITIES.items()
        if capabilities[capability] is not False
    ]
    if capabilities["cloudLayers"]:
        declared.extend(_CLOUD_LAYER_FIELDS)
    return tuple(declared)


def _generate_ensemble_profile(
    definition: Mapping[str, Any], repository_root: Path
) -> dict[str, Any]:
    baseline = _load_baseline(definition, repository_root)
    source = _prepare_source(definition, baseline)
    _apply_transforms(definition, source)
    member_profiles = []
    for member_index in range(definition["ensemble"]["members"]):
        member_source = copy.deepcopy(source)
        _apply_member_perturbations(definition, member_source, member_index)
        _validate_source(definition, member_source)
        member_profiles.append(
            derive_windgram_profile(
                member_source,
                model=definition["id"],
                semantics=definition["semantics"],
            )
        )

    first = member_profiles[0]
    optional_scalars = _declared_optional_surface_scalars(definition)
    profile = round_document(
        {
            "schemaVersion": first["schemaVersion"],
            "model": definition["id"],
            "run": {
                **first["run"],
                "members": definition["ensemble"]["members"],
            },
            "site": first["site"],
            "semantics": first["semantics"],
            "hours": aggregate_member_profiles(
                member_profiles,
                surface_scalars=(*_ENSEMBLE_SURFACE_SCALARS, *optional_scalars),
                # The contract treats these fields as additive: a member hour
                # without one contributes nothing rather than failing, and the
                # block still reports its contributor count.
                optional_surface_scalars=optional_scalars,
            ),
        }
    )
    _validate_profile(definition, profile, repository_root)
    _evaluate_assertions(definition, profile)
    return profile


def _generate_comparison_profiles(
    definition: Mapping[str, Any], repository_root: Path
) -> dict[str, dict[str, Any]]:
    baseline = _load_baseline(definition, repository_root)
    profiles = {}
    for variant in definition["comparison"]["variants"]:
        variant_definition = _definition_for_variant(definition, variant["id"])
        source = _prepare_source(variant_definition, baseline)
        _apply_transforms(variant_definition, source)
        _validate_source(variant_definition, source)
        profile = round_document(
            derive_windgram_profile(
                source,
                model=definition["id"],
                semantics=definition["semantics"],
            )
        )
        _validate_profile(definition, profile, repository_root)
        profiles[variant["id"]] = profile
    _evaluate_assertions(definition, profiles)
    return profiles


def _output_payloads(
    definition: Mapping[str, Any], repository_root: Path
) -> list[tuple[str, bytes, dict[str, str]]]:
    scenario_id = definition["id"]
    if definition["kind"] == "comparison":
        profiles = _generate_comparison_profiles(definition, repository_root)
        return [
            (
                f"{scenario_id}.{variant['id']}.profile.json",
                _json_bytes(profiles[variant["id"]]),
                {"variant": variant["id"], "title": variant["title"]},
            )
            for variant in definition["comparison"]["variants"]
        ]
    profile = generate_scenario(definition, repository_root=repository_root)
    return [(f"{scenario_id}.profile.json", _json_bytes(profile), {})]


def _build_artifacts(repository_root: Path) -> tuple[dict[Path, bytes], bytes]:
    definitions_dir = repository_root / "scenarios" / "definitions"
    generated_dir = repository_root / "scenarios" / "generated"
    artifacts: dict[Path, bytes] = {}
    entries: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for definition_path in sorted(definitions_dir.glob("*.json")):
        definition = _load_json(definition_path)
        if not isinstance(definition, dict):
            raise ScenarioError(f"{definition_path}: definition must be a JSON object")
        validate_definition(
            definition, repository_root=repository_root, source=str(definition_path)
        )
        scenario_id = definition["id"]
        if scenario_id in seen_ids:
            raise ScenarioError(f"duplicate scenario id {scenario_id!r}")
        seen_ids.add(scenario_id)
        output_payloads = _output_payloads(definition, repository_root)
        outputs = []
        for filename, payload, metadata in output_payloads:
            output_path = generated_dir / filename
            artifacts[output_path] = payload
            outputs.append(
                {
                    **metadata,
                    "path": f"generated/{filename}",
                    "sha256": hashlib.sha256(payload).hexdigest(),
                }
            )
        representative = json.loads(output_payloads[0][1])
        entries.append(
            {
                "id": scenario_id,
                "title": definition["title"],
                "lesson": definition["lesson"],
                "kind": definition["kind"],
                "modelShape": definition["modelShape"],
                "timeZone": definition["timeZone"],
                "site": representative["site"],
                # The launch the scenario teaches against — index metadata,
                # deliberately not a document field: renderers pass it as
                # SceneOptions.launch, the same seam production consumers use.
                "launch": definition["launch"],
                "capabilities": definition["capabilities"],
                "outputs": outputs,
            }
        )
    kind_order = {"deterministic": 0, "ensemble": 1, "comparison": 2}
    entries.sort(key=lambda entry: (kind_order[entry["kind"]], entry["id"]))
    return artifacts, _json_bytes({"schemaVersion": 1, "scenarios": entries})


def generate_repository(*, repository_root: Path = REPOSITORY_ROOT) -> list[Path]:
    """Regenerate every discovered profile and the public scenario index."""
    artifacts, index_payload = _build_artifacts(repository_root)
    generated_dir = repository_root / "scenarios" / "generated"
    generated_dir.mkdir(parents=True, exist_ok=True)
    expected_paths = set(artifacts)
    for stale in generated_dir.glob("*.profile.json"):
        if stale not in expected_paths:
            stale.unlink()
    for path, payload in artifacts.items():
        path.write_bytes(payload)
    index_path = repository_root / "scenarios" / "index.json"
    index_path.write_bytes(index_payload)
    return [*sorted(artifacts), index_path]


def check_repository(*, repository_root: Path = REPOSITORY_ROOT) -> None:
    """Fail without writing if committed scenario artifacts are stale or missing."""
    artifacts, index_payload = _build_artifacts(repository_root)
    expected = {**artifacts, repository_root / "scenarios" / "index.json": index_payload}
    problems: list[str] = []
    for path, payload in expected.items():
        if not path.is_file():
            problems.append(f"missing {path.relative_to(repository_root)}")
        elif path.read_bytes() != payload:
            problems.append(f"stale {path.relative_to(repository_root)}")
    generated_dir = repository_root / "scenarios" / "generated"
    for stale in sorted(set(generated_dir.glob("*.profile.json")) - set(artifacts)):
        problems.append(f"unmanaged {stale.relative_to(repository_root)}")
    if problems:
        raise ScenarioCheckError(
            "generated scenarios do not match their definitions:\n  "
            + "\n  ".join(problems)
            + "\nrun `uv run --project pipeline windgram scenarios generate`"
        )


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("generate", "check"))
    return parser


def _resolve_repository_root() -> Path:
    """The source checkout scenario commands operate on.

    The working directory and its ancestors win, so running from any checkout
    operates on that checkout; the checkout this module was imported from is
    only the fallback for unrelated working directories.
    """
    cwd = Path.cwd()
    for candidate in (cwd, *cwd.parents, REPOSITORY_ROOT):
        if (candidate / "scenarios" / "scenario.schema.json").is_file() and (
            candidate / "toolkit" / "schema"
        ).is_dir():
            return candidate
    raise ScenarioError("scenario commands must run inside a Windgram source checkout")


def main(argv: list[str] | None = None) -> int:
    arguments = _parser().parse_args(argv)
    try:
        repository_root = _resolve_repository_root()
        if arguments.command == "generate":
            paths = generate_repository(repository_root=repository_root)
            print(
                f"generated {len(paths) - 1} scenario profile(s) and "
                f"scenarios/index.json in {repository_root}"
            )
        else:
            check_repository(repository_root=repository_root)
            print(f"generated scenarios in {repository_root} match their definitions")
    except ScenarioError as error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":  # pragma: no cover - exercised through the CLI
    raise SystemExit(main())
