import gzip
import json
import os

from pathlib import Path

from windgram.publish import append_history


def profile(site_id: str, reference_time: str) -> dict:
    return {
        "schemaVersion": 1,
        "model": "hrdps-continental",
        "run": {"referenceTime": reference_time, "generatedAt": reference_time},
        "site": {"id": site_id},
        "hours": [],
    }


def test_appends_one_readable_json_line_per_run(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)

    append_history(profile("dundee", "2026-08-07T12:00:00Z"), Path("data/hrdps-continental/history"))
    append_history(profile("dundee", "2026-08-07T18:00:00Z"), Path("data/hrdps-continental/history"))

    archive = tmp_path / "data/hrdps-continental/history/dundee/2026.jsonl.gz"
    with gzip.open(archive, "rt") as handle:
        runs = [json.loads(line) for line in handle]
    assert [run["run"]["referenceTime"] for run in runs] == [
        "2026-08-07T12:00:00Z",
        "2026-08-07T18:00:00Z",
    ]


def test_rotates_archives_by_reference_year(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    append_history(profile("erie", "2026-12-31T18:00:00Z"), Path("data/hrdps-continental/history"))
    append_history(profile("erie", "2027-01-01T00:00:00Z"), Path("data/hrdps-continental/history"))

    assert sorted(os.listdir(tmp_path / "data/hrdps-continental/history/erie")) == [
        "2026.jsonl.gz",
        "2027.jsonl.gz",
    ]
