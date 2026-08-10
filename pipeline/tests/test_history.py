import gzip
import json
import os

from pathlib import Path

import pytest

from windgram import publish
from windgram.publish import append_history, append_history_lines, compact_json


def profile(site_id: str, reference_time: str) -> dict:
    return {
        "schemaVersion": 1,
        "model": "hrdps-continental",
        "run": {"referenceTime": reference_time, "generatedAt": reference_time},
        "site": {"id": site_id},
        "hours": [],
    }


def archived_line(document: dict) -> bytes:
    return gzip.compress((compact_json(document) + "\n").encode())


def read_runs(archive: Path) -> list[str]:
    with gzip.open(archive, "rt") as handle:
        return [json.loads(line)["run"]["referenceTime"] for line in handle]


def no_published_history(monkeypatch):
    monkeypatch.setattr(publish, "published_history", lambda model, site, month: b"")


def test_first_touch_seeds_the_archive_from_the_published_month(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    fetched = []

    def published_history(model: str, site_id: str, month: str) -> bytes:
        fetched.append((model, site_id, month))
        return archived_line(profile(site_id, "2026-08-07T06:00:00Z"))

    monkeypatch.setattr(publish, "published_history", published_history)

    append_history(profile("dundee", "2026-08-07T12:00:00Z"), Path("data/hrdps-continental/history"))

    assert fetched == [("hrdps-continental", "dundee", "2026-08")]
    assert read_runs(tmp_path / "data/hrdps-continental/history/dundee/2026-08.jsonl.gz") == [
        "2026-08-07T06:00:00Z",
        "2026-08-07T12:00:00Z",
    ]


def test_an_unpublished_month_starts_a_fresh_archive(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    no_published_history(monkeypatch)

    append_history(profile("dundee", "2026-08-07T12:00:00Z"), Path("data/hrdps-continental/history"))

    assert read_runs(tmp_path / "data/hrdps-continental/history/dundee/2026-08.jsonl.gz") == [
        "2026-08-07T12:00:00Z",
    ]


def test_appends_one_readable_json_line_per_run_without_refetching(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    fetches = []
    monkeypatch.setattr(
        publish,
        "published_history",
        lambda model, site, month: fetches.append(month) or b"",
    )

    append_history(profile("dundee", "2026-08-07T12:00:00Z"), Path("data/hrdps-continental/history"))
    append_history(profile("dundee", "2026-08-07T18:00:00Z"), Path("data/hrdps-continental/history"))

    # A local archive is already the fetched-and-appended truth: only the
    # first touch asks the data base.
    assert fetches == ["2026-08"]
    assert read_runs(tmp_path / "data/hrdps-continental/history/dundee/2026-08.jsonl.gz") == [
        "2026-08-07T12:00:00Z",
        "2026-08-07T18:00:00Z",
    ]


def test_history_lines_seed_from_the_published_month_then_append(tmp_path, monkeypatch):
    """Observation datasets archive one observation object per line —
    same first-touch seeding as profile history, caller-chosen grammar."""
    fetched = []

    def published_history(model: str, site_id: str, month: str) -> bytes:
        fetched.append((model, site_id, month))
        return archived_line({"observedAt": "2026-08-09T19:50:21Z", "aot": 1.1})

    monkeypatch.setattr(publish, "published_history", published_history)

    append_history_lines(
        "goes18-aod",
        "dundee",
        "2026-08",
        [
            {"observedAt": "2026-08-09T20:00:21Z", "aot": 1.934},
            {"observedAt": "2026-08-09T20:10:21Z", "aot": 2.906},
        ],
        tmp_path / "history",
    )

    assert fetched == [("goes18-aod", "dundee", "2026-08")]
    with gzip.open(tmp_path / "history/dundee/2026-08.jsonl.gz", "rt") as handle:
        assert [json.loads(line)["observedAt"] for line in handle] == [
            "2026-08-09T19:50:21Z",  # the seeded published line survives
            "2026-08-09T20:00:21Z",
            "2026-08-09T20:10:21Z",
        ]


def test_history_lines_with_nothing_new_touch_nothing(tmp_path, monkeypatch):
    monkeypatch.setattr(
        publish,
        "published_history",
        lambda *args: pytest.fail("an empty batch must not fetch or seed"),
    )

    append_history_lines("goes18-aod", "dundee", "2026-08", [], tmp_path / "history")

    assert not (tmp_path / "history").exists()


def test_rotates_archives_by_reference_month(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    no_published_history(monkeypatch)
    append_history(profile("erie", "2026-08-31T18:00:00Z"), Path("data/hrdps-continental/history"))
    append_history(profile("erie", "2026-09-01T00:00:00Z"), Path("data/hrdps-continental/history"))
    append_history(profile("erie", "2027-01-01T00:00:00Z"), Path("data/hrdps-continental/history"))

    assert sorted(os.listdir(tmp_path / "data/hrdps-continental/history/erie")) == [
        "2026-08.jsonl.gz",
        "2026-09.jsonl.gz",
        "2027-01.jsonl.gz",
    ]
