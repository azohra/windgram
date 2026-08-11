"""One-time repack of the legacy year history archives into the month
scheme (`windgram repack`).

The month-file public archive started 2026-08-10; the legacy
{site}/{YYYY}.jsonl.gz year files hold a few earlier runs the month
files lack (verified live: geps/erie's 2026 file holds a 2026-08-08T12Z
run that appears in no month file). Without a repack, "documents
through time" silently starts at 2026-08-10 for readers of the month
scheme. This tool reads a year file, buckets its runs by referenceTime
month, appends the runs the month archives are missing — deduped
keep-latest-generatedAt, so a run already present with an equal or
later generatedAt is never doubled — rewrites each touched month's
sidecar index, verifies every year line survived the merge, and then
deletes the year file so no run ever has two sources of truth.

Run BY HAND, once, with the upload credentials — never from the
scheduled build, and never concurrently with a build's upload of the
same model's months. The credentials are a correctness guard, not just
access: publishing reads through the authenticated S3 endpoint, so the
seed bytes and the pre-upload check can never be a stale CDN copy.

Safety, in the order it is enforced:
- The merge rides seeded_month_archive: every month starts from the
  published bytes and is only ever appended to, so the upload is a
  strict extension of what was published — and a leftover scratch tree
  is refused, because a stale local archive would break exactly that.
- Idempotent: a re-run finds its earlier appends already published
  (equal generatedAt), appends nothing, and converges — including the
  crashed-between-upload-and-delete case, where the re-run verifies
  and finishes the deletion.
- Never publishes backwards: just before each upload the published
  archive is fetched again and must still equal the seeded bytes; a
  scheduled build racing an append in aborts the repack instead of
  being overwritten.
- The year file is deleted only after every one of its lines is
  verified byte-identical in a month archive or superseded there by a
  strictly later generatedAt (the recorded GEPS double-archive shape).
"""

from __future__ import annotations

import gzip
import json
from datetime import date, timedelta
from pathlib import Path

from . import dataset
from .history import index_path, split_members, write_month_index
from .publish import seeded_month_archive

# upload-data.sh's TTL pair, mirrored: everything that can still change
# rides the short TTL; only a month that can no longer receive an append
# publishes immutable.
SHORT_TTL = "public, max-age=300"
CLOSED_TTL = "public, max-age=31536000, immutable"


def month_cache_control(month: str, today: date | None = None) -> str:
    """upload-data.sh's open/closed arithmetic: a run started just before
    a month boundary appends to the previous month after it, so the
    current AND previous months stay short; anything older is closed."""
    today = date.today() if today is None else today
    first = today.replace(day=1)
    open_months = {first.strftime("%Y-%m"), (first - timedelta(days=1)).strftime("%Y-%m")}
    return SHORT_TTL if month in open_months else CLOSED_TTL


def _run_lines(archive_bytes: bytes, label: str) -> list[tuple[str, str, str]]:
    """Every line of an archive as (referenceTime, generatedAt, line).
    A line without a run identity cannot be deduped by the rule, so the
    repack refuses to guess rather than merge it wrong."""
    parsed = []
    for member in split_members(archive_bytes):
        for line in member.lines:
            run = json.loads(line).get("run") or {}
            if "referenceTime" not in run or "generatedAt" not in run:
                raise RuntimeError(
                    f"{label} holds a line without run.referenceTime/"
                    "run.generatedAt — not the profile grammar this repack "
                    "understands; it refuses to guess a merge key"
                )
            parsed.append((run["referenceTime"], run["generatedAt"], line))
    return parsed


def repack_site_year(
    model: str, site_id: str, year: str, history_dir: Path, *, apply_changes: bool
) -> None:
    year_key = f"{model}/history/{site_id}/{year}.jsonl.gz"
    year_bytes = dataset.fetch_published(year_key)
    if year_bytes is None:
        print(f"{model}/{site_id} {year}: no year archive published; nothing to repack.")
        return
    year_lines = _run_lines(year_bytes, year_key)

    # Dedupe within the year file first — keep-latest-generatedAt per
    # referenceTime (an equal generatedAt keeps the earlier line); the
    # discarded copies must still be superseded in the verification below.
    latest: dict[str, tuple[str, str]] = {}
    for reference_time, generated_at, line in year_lines:
        kept = latest.get(reference_time)
        if kept is None or kept[0] < generated_at:
            latest[reference_time] = (generated_at, line)
    by_month: dict[str, list[tuple[str, str, str]]] = {}
    for reference_time, (generated_at, line) in sorted(latest.items()):
        by_month.setdefault(reference_time[:7], []).append((reference_time, generated_at, line))

    seeds: dict[str, bytes] = {}
    merged: dict[str, list[tuple[str, str, str]]] = {}
    touched: list[str] = []
    for month, candidates in sorted(by_month.items()):
        archive_path = history_dir / site_id / f"{month}.jsonl.gz"
        if archive_path.exists():
            raise RuntimeError(
                f"{archive_path} already exists — the repack seeds every month "
                "from the published bytes, and a leftover scratch archive could "
                "be older than what is published; start from a clean output tree"
            )
        seeded_month_archive(model, site_id, month, history_dir)
        seeds[month] = archive_path.read_bytes()
        month_label = f"{model}/history/{site_id}/{month}.jsonl.gz"
        newest: dict[str, str] = {}
        for reference_time, generated_at, _ in _run_lines(seeds[month], month_label):
            if reference_time not in newest or newest[reference_time] < generated_at:
                newest[reference_time] = generated_at
        appended = 0
        for reference_time, generated_at, line in candidates:
            if reference_time in newest and newest[reference_time] >= generated_at:
                continue
            # The same append the builders make: an independent gzip
            # member, the line bytes exactly as the year file held them.
            with archive_path.open("ab") as archive:
                archive.write(gzip.compress((line + "\n").encode()))
            appended += 1
        if appended:
            write_month_index(archive_path)
            touched.append(month)
        merged[month] = _run_lines(archive_path.read_bytes(), month_label)
        print(f"{model}/{site_id} {month}: {appended} run(s) to append from {year}.")

    _verify_year_survived(year_lines, merged, year_key)

    if not apply_changes:
        uploads = ", ".join(touched) if touched else "nothing"
        print(
            f"{model}/{site_id} {year}: dry run — would upload {uploads}, "
            "then delete the year archive."
        )
        return

    _require_upload_credentials()
    for month in touched:
        archive_path = history_dir / site_id / f"{month}.jsonl.gz"
        # Never publish backwards: the published archive must still be
        # exactly the bytes this merge seeded from — a scheduled build
        # appending mid-repack aborts the repack, never the reverse.
        if dataset.published_history(model, site_id, month) != seeds[month]:
            raise RuntimeError(
                f"{model}/history/{site_id}/{month}.jsonl.gz changed on the "
                "bucket since it was seeded (a scheduled build appended?); "
                "nothing was uploaded for this month — re-run the repack "
                "from a clean output tree"
            )
        cache_control = month_cache_control(month)
        _put_object(
            f"{model}/history/{site_id}/{month}.jsonl.gz",
            archive_path.read_bytes(),
            cache_control,
            "application/gzip",
        )
        _put_object(
            f"{model}/history/{site_id}/{month}.index.json",
            index_path(archive_path).read_bytes(),
            cache_control,
            "application/json",
        )
        print(f"{model}/{site_id} {month}: uploaded archive + index ({cache_control}).")
    _delete_object(year_key)
    print(
        f"{model}/{site_id} {year}: year archive deleted — "
        "the month scheme is the single source of truth."
    )


def _verify_year_survived(
    year_lines: list[tuple[str, str, str]],
    merged: dict[str, list[tuple[str, str, str]]],
    year_key: str,
) -> None:
    """Every year line must be byte-identical in its month archive or
    superseded there by a strictly later generatedAt. Anything else —
    say, two copies of a run agreeing on generatedAt but not on bytes —
    stops the repack before any upload, and the year file survives."""
    stranded = []
    for reference_time, generated_at, line in year_lines:
        month_lines = merged.get(reference_time[:7], [])
        if any(merged_line == line for _, _, merged_line in month_lines):
            continue
        if any(
            merged_reference == reference_time and merged_generated > generated_at
            for merged_reference, merged_generated, _ in month_lines
        ):
            continue
        stranded.append(f"{reference_time} (generatedAt {generated_at})")
    if stranded:
        raise RuntimeError(
            f"{year_key}: {len(stranded)} line(s) neither carried over nor "
            f"superseded — {'; '.join(stranded)}; nothing was uploaded and "
            "the year archive stays put"
        )


def _require_upload_credentials() -> None:
    if not dataset._s3_mode():
        raise RuntimeError(
            "repack publishes through the authenticated S3 endpoint (stale "
            "CDN reads must never seed an upload): set R2_ENDPOINT / "
            "AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY and leave "
            "WINDGRAM_DATA_BASE unset, or pass --dry-run"
        )


# The write side of dataset.py's authenticated client — private to this
# one-time tool; the scheduled pipeline uploads only through
# upload-data.sh.
def _put_object(key: str, body: bytes, cache_control: str, content_type: str) -> None:
    dataset._s3_client().put_object(
        Bucket=dataset._s3_bucket(),
        Key=key,
        Body=body,
        CacheControl=cache_control,
        ContentType=content_type,
    )


def _delete_object(key: str) -> None:
    dataset._s3_client().delete_object(Bucket=dataset._s3_bucket(), Key=key)
