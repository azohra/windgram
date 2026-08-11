"""The one-time year-file repack: merge, dedupe, verification, and the
publish guards — exercised against the recorded GEPS case shape (one
run archived twice with different generatedAt, one copy scaled wrong)."""

import gzip
import io
import json

from datetime import date

import pytest

from windgram import cli, dataset, repack
from windgram.publish import compact_json


def run_document(reference_time: str, generated_at: str, terrain_m: float = 173.0) -> dict:
    return {
        "schemaVersion": 1,
        "model": "geps",
        "run": {"referenceTime": reference_time, "generatedAt": generated_at},
        "site": {"id": "erie", "terrainM": terrain_m},
        "hours": [],
    }


def member(*documents: dict) -> bytes:
    return gzip.compress("".join(compact_json(d) + "\n" for d in documents).encode())


# The recorded case: the 2026-08-08T12Z run archived twice — the first
# copy carrying decametre-scaled terrain, the republication fixed — plus
# an earlier run only the year file holds.
A_OLD = run_document("2026-08-08T12:00:00Z", "2026-08-08T14:03:00Z", terrain_m=1730.0)
A_NEW = run_document("2026-08-08T12:00:00Z", "2026-08-09T02:11:00Z")
B_JULY = run_document("2026-07-30T12:00:00Z", "2026-07-30T14:00:00Z")
C_MONTH_ONLY = run_document("2026-08-10T00:00:00Z", "2026-08-10T02:00:00Z")

YEAR_KEY = "geps/history/erie/2026.jsonl.gz"
MONTH_KEY = "geps/history/erie/2026-08.jsonl.gz"


@pytest.fixture
def bucket(monkeypatch):
    """A published dataset the repack reads through dataset.fetch_published:
    the year file overlapping a month file on the double-archived run."""
    objects = {
        YEAR_KEY: member(A_OLD) + member(A_NEW) + member(B_JULY),
        MONTH_KEY: member(A_OLD) + member(C_MONTH_ONLY),
    }
    monkeypatch.setattr(dataset, "fetch_published", lambda path: objects.get(path))
    return objects


@pytest.fixture
def uploads(monkeypatch, bucket):
    """Records the write side and applies it to the fake bucket, with the
    credential check satisfied."""
    monkeypatch.setattr(dataset, "_s3_mode", lambda: True)
    puts, deletes = [], []

    def put_object(key, body, cache_control, content_type):
        puts.append((key, cache_control, content_type))
        bucket[key] = body

    def delete_object(key):
        deletes.append(key)
        del bucket[key]

    monkeypatch.setattr(repack, "_put_object", put_object)
    monkeypatch.setattr(repack, "_delete_object", delete_object)
    return puts, deletes


def archived_runs(data: bytes) -> list[str]:
    with gzip.GzipFile(fileobj=io.BytesIO(data)) as handle:
        return [json.loads(line)["run"]["generatedAt"] for line in handle]


def test_merge_dedupes_keep_latest_generatedAt_and_only_appends(tmp_path, bucket, uploads):
    puts, deletes = uploads
    repack.repack_site_year("geps", "erie", "2026", tmp_path / "history", apply_changes=True)

    # 2026-08: the published bytes survive verbatim as a prefix — the
    # merge appended the republication (A_NEW) and nothing else; A_OLD
    # was already there, and the year file's older copy never doubles it.
    month = bucket[MONTH_KEY]
    seed = member(A_OLD) + member(C_MONTH_ONLY)
    assert month[: len(seed)] == seed
    assert archived_runs(month) == [
        "2026-08-08T14:03:00Z",
        "2026-08-10T02:00:00Z",
        "2026-08-09T02:11:00Z",
    ]
    # 2026-07 existed only in the year file and is born as a month archive.
    assert archived_runs(bucket["geps/history/erie/2026-07.jsonl.gz"]) == [
        "2026-07-30T14:00:00Z"
    ]
    # Each touched month uploaded archive + index; the year file is gone.
    assert [key for key, _, _ in puts] == [
        "geps/history/erie/2026-07.jsonl.gz",
        "geps/history/erie/2026-07.index.json",
        "geps/history/erie/2026-08.jsonl.gz",
        "geps/history/erie/2026-08.index.json",
    ]
    assert deletes == [YEAR_KEY]
    assert YEAR_KEY not in bucket

    # The uploaded index covers the uploaded archive exactly.
    index = json.loads(bucket["geps/history/erie/2026-08.index.json"])
    assert index["archiveLength"] == len(month)
    assert [entry["generatedAt"] for entry in index["members"]] == archived_runs(month)


def test_ttls_and_content_types_follow_the_upload_script(tmp_path, bucket, uploads):
    puts, _ = uploads
    repack.repack_site_year("geps", "erie", "2026", tmp_path / "history", apply_changes=True)

    for key, cache_control, content_type in puts:
        month = key.rsplit("/", 1)[-1][:7]
        assert cache_control == repack.month_cache_control(month)
        expected = "application/json" if key.endswith(".index.json") else "application/gzip"
        assert content_type == expected


def test_month_cache_control_mirrors_the_shell_arithmetic():
    today = date(2026, 8, 10)
    assert repack.month_cache_control("2026-08", today) == repack.SHORT_TTL
    assert repack.month_cache_control("2026-07", today) == repack.SHORT_TTL
    assert repack.month_cache_control("2026-06", today) == repack.CLOSED_TTL
    assert repack.month_cache_control("2027-01", date(2027, 1, 1)) == repack.SHORT_TTL


def test_rerun_after_a_crash_before_deletion_converges(tmp_path, bucket, uploads):
    puts, deletes = uploads
    repack.repack_site_year("geps", "erie", "2026", tmp_path / "first", apply_changes=True)
    # Simulate the crash-between-upload-and-delete window: the months are
    # published, the year file is still there.
    bucket[YEAR_KEY] = member(A_OLD) + member(A_NEW) + member(B_JULY)
    puts.clear()
    deletes.clear()

    repack.repack_site_year("geps", "erie", "2026", tmp_path / "second", apply_changes=True)

    # Everything is already superseded or present: nothing re-uploads,
    # and the re-run finishes the deletion.
    assert puts == []
    assert deletes == [YEAR_KEY]


def test_a_republished_month_mid_repack_aborts_instead_of_being_overwritten(
    tmp_path, bucket, uploads, monkeypatch
):
    puts, deletes = uploads
    bucket[YEAR_KEY] = member(A_NEW)  # one month, so the race is the only event
    fetched = []
    fetch = dataset.fetch_published

    def racing_fetch(path):
        if path == MONTH_KEY and path in fetched:
            # A scheduled build appended between the seed and the upload.
            bucket[MONTH_KEY] = bucket[MONTH_KEY] + member(C_MONTH_ONLY)
        fetched.append(path)
        return fetch(path)

    monkeypatch.setattr(dataset, "fetch_published", racing_fetch)

    with pytest.raises(RuntimeError, match="changed on the bucket"):
        repack.repack_site_year("geps", "erie", "2026", tmp_path / "history", apply_changes=True)
    assert puts == []
    assert deletes == []


def test_a_leftover_scratch_archive_is_refused(tmp_path, bucket):
    stale = tmp_path / "history" / "erie" / "2026-08.jsonl.gz"
    stale.parent.mkdir(parents=True)
    stale.write_bytes(member(A_OLD))

    with pytest.raises(RuntimeError, match="already exists"):
        repack.repack_site_year("geps", "erie", "2026", tmp_path / "history", apply_changes=False)


def test_an_unsuperseded_conflict_stops_before_any_upload(tmp_path, bucket, uploads):
    """Two copies of a run agreeing on generatedAt but not on bytes is a
    merge no rule settles: the repack must stop with the year file intact."""
    puts, deletes = uploads
    conflicting = run_document("2026-08-08T12:00:00Z", "2026-08-08T14:03:00Z", terrain_m=999.0)
    bucket[YEAR_KEY] = member(conflicting)

    with pytest.raises(RuntimeError, match="neither carried over nor superseded"):
        repack.repack_site_year("geps", "erie", "2026", tmp_path / "history", apply_changes=True)
    assert puts == []
    assert deletes == []


def test_a_line_without_run_identity_refuses_to_guess(tmp_path, bucket):
    bucket[YEAR_KEY] = member({"observedAt": "2026-08-09T20:00:21Z", "aot": 1.9})

    with pytest.raises(RuntimeError, match="refuses to guess"):
        repack.repack_site_year("geps", "erie", "2026", tmp_path / "history", apply_changes=False)


def test_apply_without_credentials_names_the_fix(tmp_path, bucket, monkeypatch):
    monkeypatch.setattr(dataset, "_s3_mode", lambda: False)

    with pytest.raises(RuntimeError, match="--dry-run"):
        repack.repack_site_year("geps", "erie", "2026", tmp_path / "history", apply_changes=True)


def test_dry_run_merges_locally_and_touches_nothing_published(tmp_path, bucket, monkeypatch, capsys):
    monkeypatch.setattr(
        repack, "_put_object", lambda *a: pytest.fail("dry run uploaded")
    )
    monkeypatch.setattr(
        repack, "_delete_object", lambda *a: pytest.fail("dry run deleted")
    )

    repack.repack_site_year("geps", "erie", "2026", tmp_path / "history", apply_changes=False)

    assert YEAR_KEY in bucket
    stdout = capsys.readouterr().out
    assert "dry run — would upload 2026-07, 2026-08" in stdout
    # The local merge is complete, index included, ready to inspect.
    assert (tmp_path / "history/erie/2026-08.index.json").exists()


def test_cli_repack_dispatches_per_site_and_year(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(dataset, "fetch_published", lambda path: None)

    result = cli.main(
        [
            "repack",
            "--model",
            "geps",
            "--site",
            "erie",
            "--year",
            "2026",
            "--output",
            str(tmp_path / "data"),
            "--dry-run",
        ]
    )

    assert result == 0
    assert "geps/erie 2026: no year archive published" in capsys.readouterr().out


def test_cli_repack_rejects_an_uncatalogued_model(tmp_path, capsys):
    result = cli.main(
        ["repack", "--model", "nonesuch", "--year", "2026", "--site", "erie", "--dry-run"]
    )

    assert result == 1
    assert "unknown model slug" in capsys.readouterr().err
