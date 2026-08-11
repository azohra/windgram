import gzip
import json
import os

from pathlib import Path

import pytest

from windgram import publish
from windgram.history import index_path, month_index, write_month_index
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
        "2026-08.index.json",
        "2026-08.jsonl.gz",
        "2026-09.index.json",
        "2026-09.jsonl.gz",
        "2027-01.index.json",
        "2027-01.jsonl.gz",
    ]


def read_index(archive: Path) -> dict:
    return json.loads(index_path(archive).read_text())


def test_index_offsets_slice_the_archive_into_exact_member_boundaries(tmp_path, monkeypatch):
    """Round-trip: the index's (offset, length) pairs must cut the gzip
    file into exactly the independent members the appends wrote — a
    Range fetch of one entry decompresses to that run's line, whole."""
    monkeypatch.chdir(tmp_path)

    # A real-shaped seed: the published month already holds one run, so
    # the archive is seeded bytes + appended members, like the live one.
    monkeypatch.setattr(
        publish,
        "published_history",
        lambda model, site, month: archived_line(profile(site, "2026-08-07T00:00:00Z")),
    )
    append_history(profile("erie", "2026-08-07T06:00:00Z"), Path("data/geps/history"))
    append_history(profile("erie", "2026-08-07T12:00:00Z"), Path("data/geps/history"))

    archive = tmp_path / "data/geps/history/erie/2026-08.jsonl.gz"
    data = archive.read_bytes()
    index = read_index(archive)

    assert index["schemaVersion"] == 1
    assert index["archive"] == "2026-08.jsonl.gz"
    assert index["archiveLength"] == len(data)
    # Contiguous cover: members tile the file from byte 0 to the end.
    assert index["members"][0]["offset"] == 0
    for before, after in zip(index["members"], index["members"][1:]):
        assert after["offset"] == before["offset"] + before["length"]
    last = index["members"][-1]
    assert last["offset"] + last["length"] == len(data)
    # Each slice is a complete gzip member holding exactly its run.
    sliced = [
        gzip.decompress(data[entry["offset"] : entry["offset"] + entry["length"]])
        for entry in index["members"]
    ]
    assert [json.loads(piece)["run"]["referenceTime"] for piece in sliced] == [
        "2026-08-07T00:00:00Z",
        "2026-08-07T06:00:00Z",
        "2026-08-07T12:00:00Z",
    ]
    assert [entry["referenceTime"] for entry in index["members"]] == [
        "2026-08-07T00:00:00Z",
        "2026-08-07T06:00:00Z",
        "2026-08-07T12:00:00Z",
    ]
    assert all(entry["lines"] == 1 for entry in index["members"])
    assert index["members"][1]["generatedAt"] == "2026-08-07T06:00:00Z"


def test_every_append_rewrites_the_index_to_cover_the_whole_archive(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    no_published_history(monkeypatch)
    archive = tmp_path / "data/geps/history/erie/2026-08.jsonl.gz"

    append_history(profile("erie", "2026-08-07T06:00:00Z"), Path("data/geps/history"))
    assert len(read_index(archive)["members"]) == 1

    append_history(profile("erie", "2026-08-07T12:00:00Z"), Path("data/geps/history"))
    index = read_index(archive)
    assert len(index["members"]) == 2
    assert index["archiveLength"] == archive.stat().st_size

    # Deterministic: the index is a pure function of the archive bytes,
    # so recomputing it rewrites the identical document.
    first_write = index_path(archive).read_bytes()
    write_month_index(archive)
    assert index_path(archive).read_bytes() == first_write


def test_observation_batch_members_index_their_observedAt_span(tmp_path, monkeypatch):
    """Observation datasets archive a whole batch of instants per member
    (goes.py); the index carries the batch's span, not a run identity."""
    no_published_history(monkeypatch)

    append_history_lines(
        "goes18-aod",
        "erie",
        "2026-08",
        [
            {"observedAt": "2026-08-09T20:00:21Z", "aot": 1.934},
            {"observedAt": "2026-08-09T20:10:21Z", "aot": 2.906},
        ],
        tmp_path / "history",
    )

    index = read_index(tmp_path / "history/erie/2026-08.jsonl.gz")
    assert index["members"] == [
        {
            "offset": 0,
            "length": index["archiveLength"],
            "lines": 2,
            "firstObservedAt": "2026-08-09T20:00:21Z",
            "lastObservedAt": "2026-08-09T20:10:21Z",
        }
    ]


def test_index_computation_rejects_a_truncated_member(tmp_path):
    whole = archived_line(profile("erie", "2026-08-07T06:00:00Z"))
    with pytest.raises(ValueError, match="truncated gzip member at byte 0"):
        month_index(whole[:-4], "2026-08.jsonl.gz")
