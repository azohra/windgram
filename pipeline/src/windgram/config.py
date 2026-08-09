"""Shared publisher paths and scoped configuration.

Builders keep their historical ``sites.json`` and ``data/`` defaults when
run directly.  The product CLI installs a configuration only for the duration
of a dispatch, allowing callers to keep both paths outside the checkout
without leaving process-global state behind.
"""

from __future__ import annotations

import os
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator


class PublisherConfigurationError(RuntimeError):
    """Publisher paths or options cannot be used safely."""


@dataclass(frozen=True)
class PublisherConfig:
    sites_path: Path = Path("sites.json")
    output_root: Path = Path("data")
    max_steps: int | None = None


_ACTIVE_CONFIG: ContextVar[PublisherConfig | None] = ContextVar(
    "windgram_publisher_config", default=None
)
_DEFAULT_CONFIG = PublisherConfig()


def active_config() -> PublisherConfig:
    """Return the current dispatch configuration or direct-module defaults."""

    return _ACTIVE_CONFIG.get() or _DEFAULT_CONFIG


@contextmanager
def publisher_context(config: PublisherConfig) -> Iterator[None]:
    """Install *config* for this context and restore the previous value."""

    token = _ACTIVE_CONFIG.set(config)
    try:
        yield
    finally:
        _ACTIVE_CONFIG.reset(token)


def sites_path() -> Path:
    return active_config().sites_path


def output_directory(model_slug: str) -> Path:
    return active_config().output_root / model_slug


def resolve_path(path: Path) -> Path:
    """Resolve a user path without requiring its final component to exist."""

    return path.expanduser().resolve(strict=False)


def validate_sites_path(path: Path) -> None:
    if not path.exists():
        raise PublisherConfigurationError(f"sites file does not exist: {path}")
    if not path.is_file():
        raise PublisherConfigurationError(f"sites path is not a file: {path}")
    if not os.access(path, os.R_OK):
        raise PublisherConfigurationError(f"sites file is not readable: {path}")


def prepare_output_root(path: Path, *, create: bool) -> None:
    """Validate an output root and optionally create it.

    ``create=False`` performs no writes, which keeps ``--dry-run`` useful in
    read-only and review environments.
    """

    if path.exists():
        if not path.is_dir():
            raise PublisherConfigurationError(f"output path is not a directory: {path}")
        if not os.access(path, os.W_OK | os.X_OK):
            raise PublisherConfigurationError(f"output directory is not writable: {path}")
        return

    ancestor = path.parent
    while not ancestor.exists() and ancestor != ancestor.parent:
        ancestor = ancestor.parent
    if not ancestor.is_dir() or not os.access(ancestor, os.W_OK | os.X_OK):
        raise PublisherConfigurationError(
            f"output directory cannot be created under {ancestor}: {path}"
        )
    if not create:
        return
    try:
        path.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        raise PublisherConfigurationError(
            f"could not create output directory {path}: {error}"
        ) from error
