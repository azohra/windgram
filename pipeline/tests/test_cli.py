from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from windgram import cli
from windgram.config import PublisherConfig, output_directory, publisher_context, sites_path


SITE = {
    "slug": "test-hill",
    "name": "Test Hill",
    "latitude": 49.0,
    "longitude": -117.0,
    "elevationM": 1000,
}


def write_sites(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"schemaVersion": 1, "sites": [SITE]}))
    return path


def test_registry_covers_every_catalogued_model():
    catalogue = json.loads(Path("models.json").read_text())

    assert cli.MODEL_SLUGS == tuple(model["slug"] for model in catalogue["models"])


def test_dry_run_accepts_external_sites_and_output_without_writing_or_dispatching(
    tmp_path, monkeypatch, capsys
):
    sites = write_sites(tmp_path / "club" / "launches.json")
    output = tmp_path / "publish" / "profiles"
    monkeypatch.setattr(
        cli, "_run_builder", lambda *_: pytest.fail("dry-run dispatched a builder")
    )

    result = cli.main(
        [
            "build",
            "--model",
            "hrrr-conus",
            "--sites",
            str(sites),
            "--output",
            str(output),
            "--max-steps",
            "2",
            "--dry-run",
        ]
    )

    assert result == 0
    assert not output.exists()
    stdout = capsys.readouterr().out
    assert str(sites) in stdout
    assert str(output) in stdout


def test_dispatch_scopes_external_paths_and_max_steps_without_state_leaks(
    tmp_path, monkeypatch
):
    sites = write_sites(tmp_path / "launches.json")
    output = tmp_path / "static"
    calls = []
    previous = os.environ.get("WINDGRAM_MAX_STEPS")
    os.environ["WINDGRAM_MAX_STEPS"] = "91"

    def record(model: str, max_steps: int | None) -> None:
        calls.append(
            (
                model,
                max_steps,
                sites_path(),
                output_directory(model),
                os.environ["WINDGRAM_MAX_STEPS"],
            )
        )

    monkeypatch.setattr(cli, "_run_builder", record)
    try:
        result = cli.main(
            [
                "build",
                "--model",
                "gfs",
                "--sites",
                str(sites),
                "--output",
                str(output),
                "--max-steps",
                "3",
            ]
        )

        assert result == 0
        assert calls == [("gfs", 3, sites, output / "gfs", "3")]
        assert sites_path() == Path("sites.json")
        assert output_directory("gfs") == Path("data/gfs")
        assert os.environ["WINDGRAM_MAX_STEPS"] == "91"
    finally:
        if previous is None:
            os.environ.pop("WINDGRAM_MAX_STEPS", None)
        else:
            os.environ["WINDGRAM_MAX_STEPS"] = previous


def test_context_restores_paths_when_a_builder_fails(tmp_path):
    config = PublisherConfig(tmp_path / "sites.json", tmp_path / "out", 1)

    with pytest.raises(RuntimeError):
        with publisher_context(config):
            assert sites_path() == config.sites_path
            raise RuntimeError("boom")

    assert sites_path() == Path("sites.json")


def test_failed_dispatch_restores_environment_and_path_context(
    tmp_path, monkeypatch, capsys
):
    sites = write_sites(tmp_path / "sites.json")
    previous = os.environ.get("WINDGRAM_MAX_STEPS")
    os.environ["WINDGRAM_MAX_STEPS"] = "91"

    def fail(*_):
        raise ValueError("boom")

    monkeypatch.setattr(cli, "_run_builder", fail)
    try:
        result = cli.main(
            [
                "build",
                "--model",
                "gfs",
                "--sites",
                str(sites),
                "--output",
                str(tmp_path / "out"),
                "--max-steps",
                "2",
            ]
        )

        assert result == 1
        assert "gfs build failed: boom" in capsys.readouterr().err
        assert os.environ["WINDGRAM_MAX_STEPS"] == "91"
        assert sites_path() == Path("sites.json")
        assert output_directory("gfs") == Path("data/gfs")
    finally:
        if previous is None:
            os.environ.pop("WINDGRAM_MAX_STEPS", None)
        else:
            os.environ["WINDGRAM_MAX_STEPS"] = previous


def test_existing_builder_writes_to_external_output_without_network(tmp_path, monkeypatch):
    from windgram.builders import hrrr

    sites = write_sites(tmp_path / "club" / "sites.json")
    output = tmp_path / "public" / "windgrams"
    sampled_sites = []
    monkeypatch.setattr(
        hrrr, "_latest_complete_run", lambda: {"date": "20260807", "hour": "12"}
    )
    monkeypatch.setattr(hrrr, "published_reference_time", lambda slug: None)

    def build_profiles(run, reference_time, configured_sites, stats):
        sampled_sites.extend(configured_sites)
        return {
            "profiles": [],
            "firstForecastHour": 1,
            "forecastHours": [1],
            "lastForecastHour": 1,
        }

    monkeypatch.setattr(hrrr, "_build_profiles", build_profiles)

    result = cli.main(
        [
            "build",
            "--model",
            "hrrr-conus",
            "--sites",
            str(sites),
            "--output",
            str(output),
        ]
    )

    assert result == 0
    assert sampled_sites == [SITE]
    manifest = json.loads((output / "hrrr-conus" / "manifest.json").read_text())
    assert manifest["model"] == "hrrr-conus"
    assert manifest["sites"] == [{"name": SITE["name"], "slug": SITE["slug"]}]


def test_builder_skips_a_run_the_data_base_already_publishes(tmp_path, monkeypatch, capsys):
    from windgram.builders import hrrr

    sites = write_sites(tmp_path / "sites.json")
    output = tmp_path / "static"
    monkeypatch.setattr(
        hrrr, "_latest_complete_run", lambda: {"date": "20260807", "hour": "12"}
    )
    # The already-published check asks the public data base, never the
    # scratch output tree — a queued job with an empty tree must not
    # rebuild a run another job already uploaded.
    monkeypatch.setattr(
        hrrr, "published_reference_time", lambda slug: "2026-08-07T12:00:00Z"
    )
    monkeypatch.setattr(
        hrrr, "_build_profiles", lambda *_: pytest.fail("rebuilt a published run")
    )

    result = cli.main(
        ["build", "--model", "hrrr-conus", "--sites", str(sites), "--output", str(output)]
    )

    assert result == 0
    assert "already published" in capsys.readouterr().out
    assert not (output / "hrrr-conus").exists()


@pytest.mark.parametrize(
    ("arguments", "message"),
    [
        (["--model", "not-a-model"], "unknown model slug 'not-a-model'"),
        (["--model", "gfs", "--sites", "missing.json"], "sites file does not exist"),
    ],
)
def test_actionable_selection_and_sites_errors(tmp_path, capsys, arguments, message):
    sites = write_sites(tmp_path / "sites.json")
    base = ["build", "--sites", str(sites), "--output", str(tmp_path / "out")]

    result = cli.main(base + arguments)

    assert result == 1
    assert message in capsys.readouterr().err


def test_unwritable_output_error_is_actionable(tmp_path, monkeypatch, capsys):
    sites = write_sites(tmp_path / "sites.json")
    output = tmp_path / "read-only"
    output.mkdir()
    real_access = os.access

    monkeypatch.setattr(
        "windgram.config.os.access",
        lambda path, mode: False if Path(path) == output else real_access(path, mode),
    )

    result = cli.main(
        ["build", "--model", "gfs", "--sites", str(sites), "--output", str(output)]
    )

    assert result == 1
    assert f"output directory is not writable: {output}" in capsys.readouterr().err


def test_build_all_dispatches_in_catalogue_order_without_network(tmp_path, monkeypatch):
    sites = write_sites(tmp_path / "sites.json")
    calls = []
    monkeypatch.setattr(cli, "_run_builder", lambda slug, max_steps: calls.append(slug))

    result = cli.main(
        [
            "build",
            "--all",
            "--sites",
            str(sites),
            "--output",
            str(tmp_path / "out"),
            "--max-steps",
            "1",
        ]
    )

    assert result == 0
    assert calls == list(cli.MODEL_SLUGS)


def make_checkout(root: Path) -> Path:
    (root / "scenarios").mkdir(parents=True)
    (root / "scenarios" / "scenario.schema.json").write_text("{}")
    (root / "toolkit" / "schema").mkdir(parents=True)
    return root


def test_scenarios_generate_writes_the_checkout_you_stand_in(
    tmp_path, monkeypatch, capsys
):
    from windgram import scenarios

    checkout = make_checkout(tmp_path / "other-checkout")
    nested = checkout / "scenarios" / "definitions"
    nested.mkdir()
    monkeypatch.chdir(nested)
    calls = []

    def generate(*, repository_root):
        calls.append(repository_root)
        return [
            repository_root / "scenarios/generated/example.profile.json",
            repository_root / "scenarios/index.json",
        ]

    monkeypatch.setattr(scenarios, "generate_repository", generate)

    assert cli.main(["scenarios", "generate"]) == 0
    # The working directory's checkout wins over the checkout the module was
    # installed from, and the success message names the tree written.
    assert calls == [checkout]
    assert str(checkout) in capsys.readouterr().out


def test_scenarios_check_falls_back_to_the_install_source_checkout(
    tmp_path, monkeypatch
):
    from windgram import scenarios

    unrelated = tmp_path / "unrelated-cwd"
    unrelated.mkdir()
    monkeypatch.chdir(unrelated)
    calls = []
    monkeypatch.setattr(
        scenarios,
        "check_repository",
        lambda *, repository_root: calls.append(repository_root),
    )

    assert cli.main(["scenarios", "check"]) == 0
    assert calls == [scenarios.REPOSITORY_ROOT]


def test_scenarios_outside_any_checkout_fail_actionably(
    tmp_path, monkeypatch, capsys
):
    from windgram import scenarios

    unrelated = tmp_path / "unrelated-cwd"
    unrelated.mkdir()
    monkeypatch.chdir(unrelated)
    monkeypatch.setattr(scenarios, "REPOSITORY_ROOT", tmp_path / "not-a-checkout")

    assert cli.main(["scenarios", "generate"]) == 1
    assert "source checkout" in capsys.readouterr().err


def test_ensemble_cap_uses_first_scheduled_steps():
    class Ensemble:
        FORECAST_HOURS = (3, 6, 9, 12)

    assert cli._ensemble_arguments(Ensemble(), 2) == ["--steps", "3,6"]
    assert cli._ensemble_arguments(Ensemble(), None) == []


def test_hrdps_west_max_steps_preserves_default_schedule(monkeypatch):
    from windgram.builders import hrdps_west

    monkeypatch.delenv("WINDGRAM_MAX_STEPS", raising=False)
    assert hrdps_west._forecast_hours() == tuple(range(1, hrdps_west.FORECAST_HOURS + 1))

    monkeypatch.setenv("WINDGRAM_MAX_STEPS", "2")
    assert hrdps_west._forecast_hours() == (1, 2)


def test_direct_module_output_defaults_are_unchanged():
    from windgram.builders import eccc, geps, gfs, hrdps_west, hrrr, reps

    assert eccc.HRDPS.out_dir == Path("data/hrdps-continental")
    assert eccc.RDPS.out_dir == Path("data/rdps")
    assert eccc.GDPS.out_dir == Path("data/gdps")
    assert hrdps_west._out_dir() == Path("data/hrdps-west")
    assert hrrr._out_dir() == Path("data/hrrr-conus")
    assert gfs._out_dir() == Path("data/gfs")
    assert reps._out_dir() == Path("data/reps")
    assert geps._out_dir() == Path("data/geps")
