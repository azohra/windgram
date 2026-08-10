"""Command-line publisher for model builds and synthetic scenarios."""

from __future__ import annotations

import argparse
import os
import sys
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from pathlib import Path

from .config import (
    PublisherConfig,
    PublisherConfigurationError,
    prepare_output_root,
    publisher_context,
    resolve_path,
    validate_sites_path,
)
from .sites import load_sites, load_sites_input


MODEL_SLUGS = (
    "hrdps-west",
    "hrdps-continental",
    "hrrr-conus",
    "rdps",
    "gdps",
    "gfs",
    "nam",
    "nam-conus-nest",
    "reps",
    "geps",
    "raqdps",
    "goes18-dsr",
    "goes18-aod",
)
_DATAMART_MODELS = {
    "hrdps-continental": "HRDPS",
    "rdps": "RDPS",
    "gdps": "GDPS",
}


def _positive_integer(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be a positive integer") from error
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return parsed


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="windgram",
        description="Build and publish Windgram's static profile documents.",
    )
    commands = parser.add_subparsers(dest="command", required=True)

    build = commands.add_parser("build", help="build one or every catalogued model")
    selection = build.add_mutually_exclusive_group(required=True)
    selection.add_argument("--model", metavar="SLUG", help="catalogued model slug")
    selection.add_argument("--all", action="store_true", help="build every catalogued model")
    build.add_argument(
        "--sites",
        type=Path,
        default=Path("sites.json"),
        help="site catalogue (default: ./sites.json)",
    )
    build.add_argument(
        "--output",
        type=Path,
        default=Path("data"),
        help="static output root (default: ./data)",
    )
    build.add_argument(
        "--max-steps",
        type=_positive_integer,
        help="cap each model to its first N scheduled forecast steps",
    )
    build.add_argument(
        "--dry-run",
        action="store_true",
        help="validate and show the build plan without network access or writes",
    )

    scenarios = commands.add_parser("scenarios", help="manage synthetic teaching scenarios")
    scenarios.add_argument("action", choices=("generate", "check"))

    terrain = commands.add_parser(
        "terrain", help="generate the static site-context.json terrain catalogue"
    )
    terrain.add_argument(
        "--sites",
        type=Path,
        default=Path("sites.json"),
        help="site catalogue (default: ./sites.json)",
    )
    terrain.add_argument(
        "--output",
        type=Path,
        default=Path("site-context.json"),
        help="context document to write (default: ./site-context.json)",
    )
    return parser


def _load_sites_for_cli(path: Path, loader=load_sites) -> list[dict]:
    validate_sites_path(path)
    try:
        return loader(path)
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise PublisherConfigurationError(f"invalid sites file {path}: {error}") from error
    except RuntimeError as error:
        raise PublisherConfigurationError(f"invalid sites file {path}: {error}") from error


@contextmanager
def _maximum_steps_environment(max_steps: int | None) -> Iterator[None]:
    """Bridge existing deterministic module entry points without leaking state."""

    name = "WINDGRAM_MAX_STEPS"
    previous = os.environ.get(name)
    try:
        if max_steps is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = str(max_steps)
        yield
    finally:
        if previous is None:
            os.environ.pop(name, None)
        else:
            os.environ[name] = previous


@contextmanager
def _arguments(arguments: Sequence[str]) -> Iterator[None]:
    previous = sys.argv
    sys.argv = ["windgram"] + list(arguments)
    try:
        yield
    finally:
        sys.argv = previous


def _ensemble_arguments(module: object, max_steps: int | None) -> list[str]:
    if max_steps is None:
        return []
    hours = tuple(getattr(module, "FORECAST_HOURS"))[:max_steps]
    return ["--steps", ",".join(str(hour) for hour in hours)]


def _run_builder(model_slug: str, max_steps: int | None) -> None:
    if model_slug in _DATAMART_MODELS:
        from .builders import eccc

        eccc.main(getattr(eccc, _DATAMART_MODELS[model_slug]))
    elif model_slug == "hrdps-west":
        from .builders import hrdps_west

        hrdps_west.main()
    elif model_slug == "hrrr-conus":
        from .builders import hrrr

        hrrr.main()
    elif model_slug == "raqdps":
        from .builders import raqdps

        raqdps.main()
    elif model_slug in {"goes18-dsr", "goes18-aod"}:
        from .builders import goes

        goes.main(goes.PRODUCTS[model_slug])
    elif model_slug == "gfs":
        from .builders import gfs

        gfs.main()
    elif model_slug in {"nam", "nam-conus-nest"}:
        from .builders import nam

        nam.build(nam.PRODUCTS[model_slug])
    elif model_slug in {"reps", "geps"}:
        module = __import__(f"windgram.builders.{model_slug}", fromlist=["main"])
        with _arguments(_ensemble_arguments(module, max_steps)):
            module.main()
    else:  # Defensive: selection validation should make this unreachable.
        raise PublisherConfigurationError(f"no builder is registered for {model_slug}")


def _selected_models(arguments: argparse.Namespace) -> tuple[str, ...]:
    if arguments.all:
        return MODEL_SLUGS
    if arguments.model not in MODEL_SLUGS:
        available = ", ".join(MODEL_SLUGS)
        raise PublisherConfigurationError(
            f"unknown model slug {arguments.model!r}; choose one of: {available}"
        )
    return (arguments.model,)


def _build(arguments: argparse.Namespace) -> int:
    models = _selected_models(arguments)
    config = PublisherConfig(
        sites_path=resolve_path(arguments.sites),
        output_root=resolve_path(arguments.output),
        max_steps=arguments.max_steps,
    )
    sites = _load_sites_for_cli(config.sites_path)
    prepare_output_root(config.output_root, create=not arguments.dry_run)

    if arguments.dry_run:
        cap = f", capped at {config.max_steps} step(s)" if config.max_steps else ""
        print(
            f"Would build {', '.join(models)} for {len(sites)} site(s) from "
            f"{config.sites_path} into {config.output_root}{cap}."
        )
        return 0

    with publisher_context(config), _maximum_steps_environment(config.max_steps):
        for model_slug in models:
            try:
                _run_builder(model_slug, config.max_steps)
            except PublisherConfigurationError:
                raise
            except Exception as error:  # noqa: BLE001 - a CLI needs an actionable model label
                raise RuntimeError(f"{model_slug} build failed: {error}") from error
    return 0


def _terrain(arguments: argparse.Namespace) -> int:
    # Identity only, never the joining loader: terrain GENERATES the
    # context the join reads, so joining here would chicken-and-egg on
    # the first run after a catalogue change.
    sites = _load_sites_for_cli(resolve_path(arguments.sites), loader=load_sites_input)
    # The terrain module needs numpy (and, inside the command, rasterio —
    # both behind the `terrain` extra so cron builds stay lean); importing
    # here keeps `windgram build` clear of them.
    from . import terrain

    return terrain.generate(sites, resolve_path(arguments.output))


def _scenarios(action: str) -> int:
    # One dispatch and one root strategy: `windgram scenarios ...` is the
    # module entry point `python -m windgram.scenarios ...` under another name.
    from . import scenarios

    return scenarios.main([action])


def main(argv: Sequence[str] | None = None) -> int:
    arguments = _parser().parse_args(argv)
    try:
        if arguments.command == "build":
            return _build(arguments)
        if arguments.command == "terrain":
            return _terrain(arguments)
        return _scenarios(arguments.action)
    except (PublisherConfigurationError, RuntimeError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":  # pragma: no cover - console script exercises main
    raise SystemExit(main())
