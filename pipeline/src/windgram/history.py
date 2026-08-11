"""Byte mechanics of the month archives: gzip member splitting and the
sidecar byte-offset index.

A month archive is a sequence of INDEPENDENT gzip members — the append
flow writes each run (or observation batch) as its own member so
existing bytes are never rewritten. The sidecar index states where
those members sit: per member its byte offset, byte length, line count,
and identity — (referenceTime, generatedAt) for a profile run,
first/last observedAt for an observation batch — so a reader wanting
"the last N runs" or "runs since T" can Range-fetch only the members
it needs instead of the whole month.

The index is recomputed from the archive bytes after every append —
a pure function of the file, the same property runs.json has — and it
is ADVISORY, never authoritative: a reader that finds the index's
covered length disagreeing with the archive's Content-Length falls
back to a full fetch.
"""

from __future__ import annotations

import json
import zlib
from pathlib import Path
from typing import NamedTuple

INDEX_SCHEMA_VERSION = 1

# The archive suffix the index sits beside: 2026-08.jsonl.gz is indexed
# by 2026-08.index.json in the same directory.
ARCHIVE_SUFFIX = ".jsonl.gz"
INDEX_SUFFIX = ".index.json"


class Member(NamedTuple):
    """One independent gzip member: where it sits and what it says."""

    offset: int
    length: int
    lines: list[str]  # decompressed JSON lines, newline stripped


def split_members(data: bytes) -> list[Member]:
    """Splits archive bytes into independent gzip members with exact byte
    boundaries. A truncated or corrupt member fails loudly — the archives
    are this pipeline's own writes, so damage is a bug, never a shrug."""
    members: list[Member] = []
    offset = 0
    while offset < len(data):
        decompressor = zlib.decompressobj(wbits=zlib.MAX_WBITS | 16)
        text = decompressor.decompress(data[offset:])
        if not decompressor.eof:
            raise ValueError(f"truncated gzip member at byte {offset}")
        length = len(data) - offset - len(decompressor.unused_data)
        members.append(Member(offset, length, text.decode().splitlines()))
        offset += length
    return members


def month_index(archive_bytes: bytes, archive_name: str) -> dict:
    """The sidecar index document for one month archive: a pure function
    of the archive bytes, so recomputing after every append needs no
    incremental bookkeeping and concurrent builds converge on whoever
    writes last."""
    members = split_members(archive_bytes)
    return {
        "schemaVersion": INDEX_SCHEMA_VERSION,
        "archive": archive_name,
        "archiveLength": len(archive_bytes),
        "members": [_member_entry(member) for member in members],
    }


def _member_entry(member: Member) -> dict:
    """One member's index entry. Identity follows the line grammar: a
    profile run is one document per member and carries run.referenceTime
    and run.generatedAt; an observation batch is one instant per line and
    carries the batch's observedAt span. A member speaking neither
    grammar still indexes — offsets are the load-bearing part."""
    # Key names match the toolkit reader's index guard exactly
    # (toolkit/src/history parseHistoryIndexJson: byteOffset/byteLength);
    # a mismatch is not an error there, just a permanent silent
    # degradation to full fetches — the worst kind of wrong.
    entry: dict = {
        "byteOffset": member.offset,
        "byteLength": member.length,
        "lines": len(member.lines),
    }
    first = json.loads(member.lines[0]) if member.lines else {}
    run = first.get("run")
    if len(member.lines) == 1 and isinstance(run, dict) and "referenceTime" in run:
        entry["referenceTime"] = run["referenceTime"]
        entry["generatedAt"] = run.get("generatedAt")
    elif "observedAt" in first:
        entry["firstObservedAt"] = first["observedAt"]
        entry["lastObservedAt"] = json.loads(member.lines[-1])["observedAt"]
    return entry


def index_path(archive_path: Path) -> Path:
    return archive_path.with_name(
        archive_path.name.removesuffix(ARCHIVE_SUFFIX) + INDEX_SUFFIX
    )


def write_month_index(archive_path: Path) -> Path:
    """(Re)writes the sidecar index beside its archive from the archive's
    current bytes. Human-checkable plain JSON — the index is small and
    needs no gzip gymnastics of its own."""
    document = month_index(archive_path.read_bytes(), archive_path.name)
    path = index_path(archive_path)
    path.write_text(json.dumps(document, indent=2) + "\n")
    return path
