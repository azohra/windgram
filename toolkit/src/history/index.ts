/* history/ — documents through time: reading the published month archives.

   The bucket keeps one archive per model, site, and month at
   {model}/history/{site}/{YYYY-MM}.jsonl.gz. Each pipeline build APPENDS the
   run as an INDEPENDENT gzip member — existing bytes are never rewritten,
   which is what lets a closed month publish immutable. Inside a member: one
   compact-JSON document per line (a history line is exactly the published
   document). Observation datasets batch several instants per member, so the
   reader splits members FIRST and lines SECOND, never assuming one line per
   member (re-verified 2026-08-10 across every published model: forecast
   archives run one line per member; goes archives run 1–11 lines per member).

   WHATWG `DecompressionStream("gzip")` cannot be trusted with these
   archives — the spec treats bytes trailing the first member's end as an
   error, and the archives are deliberately multi-member. Worse, the
   runtimes disagree (re-verified 2026-08-10): Node 24.19 throws
   ERR_TRAILING_JUNK_AFTER_STREAM_END, Deno 2.9 throws a different
   TypeError, and Bun 1.3 silently decompresses every member. Hence the
   member-splitting reader here, built on node:zlib's raw-deflate decoder,
   which reports exactly how many input bytes each member's deflate stream
   consumed — the boundary DecompressionStream never surfaces. Runtime
   story: Node (24.19, the full test suite), Bun (1.3, split and load
   verified) and Deno (2.9, member splitting verified) all run it via
   node:zlib; browsers are NOT supported by this subpath — every other
   windgram subpath stays runtime-agnostic.

   Transport manners match transport/: injected fetch, discriminated
   `DocumentMiss` ("absent" vs "invalid"), `TransportHttpError` as the only
   throw, no storage side effects. One deliberate divergence:
   `TransportResponse` exposes `text()` only, and a gzip reader needs bytes —
   so history carries its own `HistoryResponse` with `arrayBuffer()` rather
   than widening the transport type under every existing test stub. */

import { inflateRawSync } from "node:zlib";
import {
  parseSmokeDocumentJson,
  parseWindgramProfileJson,
  type SmokeDocument,
  type WindgramProfile,
} from "../contract/index.js";
import { TransportHttpError, type DocumentMiss } from "../transport/index.js";

/**
 * The run stamp every archived forecast document carries — transport/'s
 * `RunStampedDocument` plus `generatedAt`, because the dedupe's whole job
 * is comparing generation stamps. Profile and smoke documents both satisfy
 * it; observation history lines deliberately do NOT (an instant has no
 * run), which is why the typed loaders are forecast-shaped and observation
 * archives are read through `splitHistoryArchive` directly.
 */
export interface HistoryDocument {
  model: string;
  run: { referenceTime: string; generatedAt: string };
}

/**
 * The subset of a WHATWG Response the history loader reads — history's own
 * response type (NOT `TransportResponse`, which is `text()`-only): a gzip
 * archive is bytes. The global WHATWG `fetch` satisfies `HistoryFetch`
 * directly; tests inject a stub.
 */
export interface HistoryResponse {
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * The injected fetch. `init.headers` carries a `Range` header on the index
 * fast path (R2 serves Range natively; re-verified 2026-08-10 through the
 * public Cloudflare-cached domain — 206 with a correct Content-Range even on
 * a CDN cache HIT, 416 past end-of-file). A server free to ignore Range and
 * answer 200 with the full body is handled honestly (see `loadHistory`).
 */
export type HistoryFetch = (
  url: string,
  init?: { headers: Record<string, string> },
) => Promise<HistoryResponse>;

/**
 * One gzip member of a month archive, split and decompressed: where its
 * bytes sit in the archive and the document lines it carried. Forecast
 * archives append one line per member; observation archives batch a whole
 * granule of instants per member — callers type the lines with their own
 * guard, exactly as transport/ callers do.
 */
export interface HistoryArchiveMember {
  /** Byte offset of the member's first byte within the archive. */
  byteOffset: number;
  /** Compressed length of the member, header and trailer included. */
  byteLength: number;
  /** The member's decompressed non-empty lines, one document per line. */
  lines: string[];
}

/**
 * Splits a month archive into its independent gzip members and decompresses
 * each — the reader that exists because `DecompressionStream("gzip")`
 * rejects multi-member archives (see the module docblock). Returns `null`
 * on structurally corrupt bytes (not gzip, truncated member, trailer length
 * mismatch), mirroring the contract guards' never-throw convention; the
 * loader reports that as a `"miss": "invalid"`. An empty archive splits to
 * an empty array.
 *
 * Accepts any archive slice that STARTS on a member boundary — a Range
 * fetch from a member offset (the index fast path) splits with the same
 * code as a full fetch.
 */
export function splitHistoryArchive(bytes: Uint8Array): HistoryArchiveMember[] | null {
  const members: HistoryArchiveMember[] = [];
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset < bytes.length) {
    const start = offset;
    // RFC 1952 member header: magic, deflate method, then optional fields.
    if (offset + 10 > bytes.length) return null;
    if (bytes[offset] !== 0x1f || bytes[offset + 1] !== 0x8b || bytes[offset + 2] !== 8) {
      return null;
    }
    const flags = bytes[offset + 3];
    offset += 10;
    if (flags & 0x04) {
      // FEXTRA: two-byte little-endian length, then that many bytes.
      if (offset + 2 > bytes.length) return null;
      offset += 2 + (bytes[offset] | (bytes[offset + 1] << 8));
    }
    for (const nulTerminated of [flags & 0x08, flags & 0x10]) {
      // FNAME, then FCOMMENT: NUL-terminated when present.
      if (!nulTerminated) continue;
      while (offset < bytes.length && bytes[offset] !== 0) offset++;
      offset++;
    }
    if (flags & 0x02) offset += 2; // FHCRC
    if (offset >= bytes.length) return null;

    // The deflate stream self-terminates; the engine reports the input
    // bytes it consumed, which is the member boundary DecompressionStream
    // never surfaces. (@types/node types the info:true result as Buffer.)
    let inflated: Uint8Array;
    let deflateLength: number;
    try {
      const result = inflateRawSync(bytes.subarray(offset), {
        info: true,
      }) as unknown as { buffer: Uint8Array; engine: { bytesWritten: number } };
      inflated = result.buffer;
      deflateLength = result.engine.bytesWritten;
    } catch {
      return null;
    }
    offset += deflateLength;

    // RFC 1952 member trailer: CRC32, then ISIZE — the decompressed length
    // mod 2^32, checked so a misaligned split cannot pass silently.
    if (offset + 8 > bytes.length) return null;
    const isize =
      (bytes[offset + 4] |
        (bytes[offset + 5] << 8) |
        (bytes[offset + 6] << 16) |
        (bytes[offset + 7] << 24)) >>>
      0;
    if (isize !== inflated.length >>> 0) return null;
    offset += 8;

    members.push({
      byteOffset: start,
      byteLength: offset - start,
      lines: decoder
        .decode(inflated)
        .split("\n")
        .filter((line) => line.length > 0),
    });
  }
  return members;
}

/**
 * One entry of the sidecar byte-offset index the pipeline publishes beside
 * an archive as {YYYY-MM}.index.json: where a member's bytes sit and which
 * run they carry, so a reader wanting "runs since T" Range-fetches only the
 * members it needs.
 */
export interface HistoryIndexMember {
  byteOffset: number;
  byteLength: number;
  referenceTime: string;
  generatedAt: string;
}

/** The sidecar index document: one entry per gzip member, archive order. */
export interface HistoryIndex {
  members: HistoryIndexMember[];
}

/**
 * Guard for the sidecar index — never throws, `null` on anything that is
 * not the index shape. The index is ADVISORY: a `null` here (or a missing
 * sidecar, the launch state) degrades to a full-archive fetch, silently
 * correct.
 */
export function parseHistoryIndexJson(text: string): HistoryIndex | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const members = (value as { members?: unknown }).members;
  if (!Array.isArray(members)) return null;
  for (const member of members) {
    if (typeof member !== "object" || member === null) return null;
    const m = member as Record<string, unknown>;
    if (
      typeof m.byteOffset !== "number" ||
      !Number.isInteger(m.byteOffset) ||
      m.byteOffset < 0 ||
      typeof m.byteLength !== "number" ||
      !Number.isInteger(m.byteLength) ||
      m.byteLength <= 0 ||
      typeof m.referenceTime !== "string" ||
      typeof m.generatedAt !== "string"
    ) {
      return null;
    }
  }
  return { members: members as HistoryIndexMember[] };
}

/**
 * A republication, stated: one run (`referenceTime`) appeared on more than
 * one archive line, the loader kept the line with the latest `generatedAt`,
 * and these are the stamps it discarded (archive order). The recorded
 * double-archived GEPS run is why this exists — without it, convergence
 * would score a pipeline fix as weather.
 */
export interface HistoryRevision {
  referenceTime: string;
  keptGeneratedAt: string;
  supersededGeneratedAt: string[];
}

/**
 * A line the contract guard rejected — a contract break or prototype data
 * inside an otherwise readable archive. Never routine; log it loudly. The
 * surviving lines still load: one corrupt line does not poison a month.
 */
export interface HistoryInvalidLine {
  /** The archive the line came from. */
  url: string;
  /** Byte offset of the gzip member carrying the line. */
  memberByteOffset: number;
  /** 1-based line number within that member. */
  line: number;
}

/**
 * A loaded history: the deduped runs, and everything the dedupe and the
 * guards had to say about the bytes. `runs` is deduped by
 * (model, referenceTime), keep-latest-`generatedAt` — mandatory, not
 * optional: it is a precondition of every statement compareRuns makes —
 * and sorted ascending by `referenceTime` (chronological, the hours
 * convention).
 */
export interface LoadedHistory<T extends HistoryDocument> {
  runs: T[];
  /** Republications the dedupe discarded, ascending by referenceTime; empty when clean. */
  revisions: HistoryRevision[];
  /** Guard-rejected lines — contract breaks to log loudly; empty when clean. */
  invalidLines: HistoryInvalidLine[];
  /**
   * Per requested month ("YYYY-MM") with nothing to contribute: `"absent"`
   * months are routine (a month file exists only once a run of that month
   * was archived); `"invalid"` means the archive bytes themselves failed to
   * split — never routine.
   */
  misses: Record<string, DocumentMiss>;
}

/** The shared options of the history loaders: where, which months, and how to narrow. */
export interface LoadSiteHistoryOptions {
  fetch: HistoryFetch;
  /** The data-tree root, as for transport/'s loaders. Trailing slash tolerated. */
  baseUrl: string;
  modelSlug: string;
  siteSlug: string;
  /** The months to read, as "YYYY-MM" keys. Order does not matter. */
  months: readonly string[];
  /**
   * Inclusive `referenceTime` lower bound. Runs before it are dropped, and
   * — when a month's sidecar index exists — enables the Range fast path:
   * only bytes from the first needed member onward are fetched. Absent
   * sidecar (the launch state), a stale sidecar, or a server ignoring
   * Range all degrade to the full fetch, silently correct: the archives
   * are append-only, so fetching from a member offset to end-of-file can
   * never miss a member the index had not yet seen.
   */
  since?: string;
}

export interface LoadHistoryOptions<T extends HistoryDocument> extends LoadSiteHistoryOptions {
  /**
   * The contract guard typing each history line — a history line is exactly
   * the published document (`parseWindgramProfileJson` for profile models,
   * `parseSmokeDocumentJson` for smoke models).
   */
  guard: (text: string) => T | null;
}

/**
 * Loads one site's month archives for a model: fetch each requested month
 * (Range-narrowed when `since` and a sidecar index allow), split gzip
 * members, split lines, guard every line, dedupe keep-latest-`generatedAt`,
 * and report what was superseded as `revisions`. Returns:
 *
 * - a `LoadedHistory` — runs ascending by referenceTime, revisions and
 *   guard-rejected lines stated, per-month misses discriminated;
 * - a `DocumentMiss` with `"absent"` when EVERY requested month is absent —
 *   the site simply has no history here (`url` names the latest requested
 *   month). Months absent alongside present ones stay routine per-month
 *   misses.
 *
 * Non-404 HTTP failures on an ARCHIVE throw `TransportHttpError`, the only
 * throw. Index fetches never throw: the sidecar is advisory, so any index
 * failure degrades to the full fetch.
 */
export async function loadHistory<T extends HistoryDocument>(
  options: LoadHistoryOptions<T>,
): Promise<LoadedHistory<T> | DocumentMiss> {
  const { fetch, modelSlug, siteSlug, guard, since } = options;
  const base = trimTrailingSlash(options.baseUrl);
  const months = [...options.months].sort();
  const archiveUrl = (month: string) => `${base}/${modelSlug}/history/${siteSlug}/${month}.jsonl.gz`;
  const indexUrl = (month: string) => `${base}/${modelSlug}/history/${siteSlug}/${month}.index.json`;

  const misses: Record<string, DocumentMiss> = {};
  const invalidLines: HistoryInvalidLine[] = [];
  /** Every guarded line in archive append order (months ascending, members in file order). */
  const lines: T[] = [];

  for (const month of months) {
    const url = archiveUrl(month);
    const fetched = await fetchArchive(fetch, url, since ? indexUrl(month) : undefined, since);
    if (fetched === "nothing-new") continue;
    if ("miss" in fetched) {
      misses[month] = fetched;
      continue;
    }
    const members = splitHistoryArchive(fetched.bytes);
    if (members === null) {
      misses[month] = { miss: "invalid", url };
      continue;
    }
    for (const member of members) {
      member.lines.forEach((text, lineIndex) => {
        const document = guard(text);
        if (document === null) {
          invalidLines.push({
            url,
            memberByteOffset: fetched.baseOffset + member.byteOffset,
            line: lineIndex + 1,
          });
          return;
        }
        // The Range fast path over-fetches from the first needed member to
        // end-of-file; both paths filter identically so index-present and
        // index-absent loads are equivalent.
        if (since !== undefined && document.run.referenceTime < since) return;
        lines.push(document);
      });
    }
  }

  if (months.length > 0 && Object.keys(misses).length === months.length) {
    const allAbsent = Object.values(misses).every((miss) => miss.miss === "absent");
    if (allAbsent) return { miss: "absent", url: archiveUrl(months[months.length - 1]) };
  }

  const { runs, revisions } = dedupeKeepLatest(lines);
  return { runs, revisions, invalidLines, misses };
}

/** `loadProfileHistory`'s options — the shared site-history shape. */
export type LoadProfileHistoryOptions = LoadSiteHistoryOptions;

/** The profile-typed `loadHistory`: a profile model's history lines are profile documents. */
export async function loadProfileHistory(
  options: LoadProfileHistoryOptions,
): Promise<LoadedHistory<WindgramProfile> | DocumentMiss> {
  return loadHistory({ ...options, guard: parseWindgramProfileJson });
}

export type LoadSmokeHistoryOptions = LoadSiteHistoryOptions;

/** The smoke-typed `loadHistory`: a smoke model's history lines are smoke documents. */
export async function loadSmokeHistory(
  options: LoadSmokeHistoryOptions,
): Promise<LoadedHistory<SmokeDocument> | DocumentMiss> {
  return loadHistory({ ...options, guard: parseSmokeDocumentJson });
}

/* ------------------------------------------------------------------ */

interface FetchedArchive {
  bytes: Uint8Array;
  /** Archive offset of bytes[0] — 0 on a full fetch, the Range start on a 206. */
  baseOffset: number;
}

/**
 * Fetches one month's archive, narrowed by the sidecar index when one is
 * usable. The narrowing never risks correctness: it always requests from a
 * member boundary TO END-OF-FILE, so a sidecar that has not yet seen the
 * newest appended members (an append racing the index upload, or a stale
 * CDN cache) still yields every byte the selection could need — the
 * append-only discipline is what makes the suffix request sufficient.
 */
async function fetchArchive(
  fetch: HistoryFetch,
  archiveUrl: string,
  indexUrl: string | undefined,
  since: string | undefined,
): Promise<FetchedArchive | DocumentMiss | "nothing-new"> {
  let rangeStart = 0;
  if (indexUrl !== undefined && since !== undefined) {
    const index = await fetchIndex(fetch, indexUrl);
    if (index !== null && index.members.length > 0) {
      const needed = index.members.filter((member) => member.referenceTime >= since);
      rangeStart =
        needed.length > 0
          ? Math.min(...needed.map((member) => member.byteOffset))
          : // Nothing indexed matches — but members appended after the index
            // was written still might, so probe the uncovered tail.
            Math.max(...index.members.map((member) => member.byteOffset + member.byteLength));
    }
  }

  if (rangeStart > 0) {
    const response = await fetch(archiveUrl, {
      headers: { Range: `bytes=${rangeStart}-` },
    });
    if (response.status === 404) return { miss: "absent", url: archiveUrl };
    // 416: the index already covered end-of-file — nothing new to read.
    if (response.status === 416) return "nothing-new";
    if (!response.ok) throw new TransportHttpError(response.status, archiveUrl);
    const bytes = new Uint8Array(await response.arrayBuffer());
    // A server free to ignore Range answers 200 with the whole archive.
    return { bytes, baseOffset: response.status === 206 ? rangeStart : 0 };
  }

  const response = await fetch(archiveUrl);
  if (response.status === 404) return { miss: "absent", url: archiveUrl };
  if (!response.ok) throw new TransportHttpError(response.status, archiveUrl);
  return { bytes: new Uint8Array(await response.arrayBuffer()), baseOffset: 0 };
}

/** The advisory index fetch: any failure at all reads as "no index" — full fetch. */
async function fetchIndex(fetch: HistoryFetch, url: string): Promise<HistoryIndex | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return parseHistoryIndexJson(new TextDecoder().decode(await response.arrayBuffer()));
  } catch {
    return null;
  }
}

/**
 * The mandatory dedupe: key (model, referenceTime), keep the line with the
 * latest `generatedAt`. Ties — equal stamps, including byte-identical
 * republished lines — keep the LAST line in archive append order (the later
 * append is the later write), and the discarded stamps are reported either
 * way: a republication is a stated fact, never silence.
 */
function dedupeKeepLatest<T extends HistoryDocument>(
  lines: readonly T[],
): { runs: T[]; revisions: HistoryRevision[] } {
  const byRun = new Map<string, { kept: T; all: T[] }>();
  for (const line of lines) {
    const key = `${line.model} ${line.run.referenceTime}`;
    const entry = byRun.get(key);
    if (entry === undefined) {
      byRun.set(key, { kept: line, all: [line] });
      continue;
    }
    entry.all.push(line);
    if (line.run.generatedAt >= entry.kept.run.generatedAt) entry.kept = line;
  }

  const runs = [...byRun.values()]
    .map((entry) => entry.kept)
    .sort((a, b) => a.run.referenceTime.localeCompare(b.run.referenceTime));
  const revisions = [...byRun.values()]
    .filter((entry) => entry.all.length > 1)
    .map((entry) => ({
      referenceTime: entry.kept.run.referenceTime,
      keptGeneratedAt: entry.kept.run.generatedAt,
      supersededGeneratedAt: entry.all
        .filter((line) => line !== entry.kept)
        .map((line) => line.run.generatedAt),
    }))
    .sort((a, b) => a.referenceTime.localeCompare(b.referenceTime));
  return { runs, revisions };
}

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
