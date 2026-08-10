/* transport/ — fetching published documents with the runtime's own fetch
   injected. Independently cached manifest and profile objects can represent
   different runs. This module detects that torn read and retries the pair.

   Deliberately I/O-shaped and nothing else:
   - fetch is INJECTED (any WHATWG-compatible fetch: browser, Node, workers,
     undici, a test stub), keeping the core packages I/O-free and this one
     runtime-agnostic;
   - NO storage side effects. No storage API is portable across runtimes;
     callers own cache keys, quotas, invalidation, and stale-data policy.
     The pair loaders report staleness and return the freshest complete
     pair they saw. */

import {
  parseObservationDocumentJson,
  parseRunsIndexJson,
  parseSmokeDocumentJson,
  parseWindgramManifestJson,
  parseWindgramProfileJson,
  type ObservationDocument,
  type RunsIndex,
  type SmokeDocument,
  type WindgramManifest,
  type WindgramProfile,
} from "../contract/index.js";

/** The subset of a WHATWG Response the transport reads. */
export interface TransportResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

/**
 * The injected fetch: `(url) => Promise<Response-like>`. The global WHATWG
 * `fetch` satisfies it directly; tests inject a stub.
 */
export type TransportFetch = (url: string) => Promise<TransportResponse>;

/** A non-404 HTTP failure — the transport's only throw. */
export class TransportHttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
  ) {
    super(`${status} fetching ${url}`);
    this.name = "TransportHttpError";
  }
}

/**
 * Why a load had nothing to return — the discriminated miss (previously a
 * bare null that conflated two very different situations):
 *
 * - `"absent"`: HTTP 404 — the model or site simply is not published
 *   here. A site outside a model's domain reads this way; it is routine
 *   and usually not worth a log line.
 * - `"invalid"`: the document EXISTS but failed the contract guard — a
 *   contract break, or a model still publishing pre-release prototype
 *   data. This is never routine; log it loudly, because rendering-wise it
 *   presents exactly like "absent" and would otherwise hide.
 *
 * `url` names the offending document. Discriminate with `"miss" in
 * result`.
 */
export interface DocumentMiss {
  miss: "absent" | "invalid";
  url: string;
}

/**
 * The run-identity stamp shared by every forecast document kind (profile
 * and smoke documents both carry it) — all the skew dance needs from a
 * document to compare it with its model's manifest. Observation documents
 * deliberately do NOT satisfy it: they have no run (see `loadObservation`).
 */
export interface RunStampedDocument {
  model: string;
  run: { referenceTime: string };
}

/**
 * The pure pair check at the heart of the skew dance: true when the
 * manifest and document describe the same model AND the same run
 * (referenceTime equality). A pair failing this check is a torn read —
 * two documents from different runs (or different models entirely) that
 * must not be rendered as one forecast. Accepts any run-stamped document
 * (profile or smoke); `WindgramProfile` callers are unchanged.
 */
export function runsConsistent(
  manifest: WindgramManifest,
  document: RunStampedDocument,
): boolean {
  return (
    manifest.model === document.model && manifest.referenceTime === document.run.referenceTime
  );
}

export interface RetryOptions {
  /** Delay before the single retry, ms. Default 1500. */
  delayMs?: number;
  /** Sleep implementation — injectable so tests never actually wait. */
  sleep?: (ms: number) => Promise<void>;
}

/** The shared options of every per-site loader: where, which, and how to retry. */
export interface LoadSiteDocumentOptions {
  fetch: TransportFetch;
  /**
   * The data-tree root, e.g.
   * "https://data.meteo.azohra.com".
   * Trailing slash tolerated.
   */
  baseUrl: string;
  modelSlug: string;
  siteSlug: string;
  retry?: RetryOptions;
}

export interface LoadDocumentOptions<T extends RunStampedDocument>
  extends LoadSiteDocumentOptions {
  /**
   * The contract guard for the SITE document (`parseWindgramProfileJson`,
   * `parseSmokeDocumentJson`, …). The manifest side of the pair is always
   * guarded by the forecast-manifest guard — one manifest shape anchors
   * every forecast document kind.
   */
  guard: (text: string) => T | null;
}

export interface LoadedDocument<T extends RunStampedDocument> {
  manifest: WindgramManifest;
  document: T;
  /**
   * True when the pair still disagreed about the run after the retry —
   * a publish is in flight and the CDN is mid-sync. Render with a "still
   * syncing" note, or fall back to a pair you cached earlier; never mix
   * the two documents as if they were one forecast.
   */
  stale: boolean;
}

/**
 * Fetches a model's manifest and one site's run-stamped document as a
 * consistent pair — the reference-time skew dance: fetch both, compare
 * `referenceTime`, and on disagreement retry the pair once after a short
 * delay (publishes are quick; the CDN usually converges within it). The
 * `guard` parameter types the site document; `loadProfile` and `loadSmoke`
 * are its typed wrappers. Returns:
 *
 * - `{ manifest, document, stale: false }` — a consistent pair;
 * - `{ manifest, document, stale: true }` — the freshest complete pair seen,
 *   still torn after the retry (see `LoadedDocument.stale`);
 * - a `DocumentMiss` — nothing to render, saying WHY: `"absent"` (404 —
 *   the model or site is not published here) or `"invalid"` (the document
 *   exists but failed the contract guard — a contract break or prototype
 *   data, which must not render as garbage and must not hide as a 404).
 *   Discriminate with `"miss" in result`.
 *
 * Non-404 HTTP errors throw `TransportHttpError`. No caching, no storage —
 * see the module docblock for why that stays consumer-side.
 */
export async function loadDocument<T extends RunStampedDocument>(
  options: LoadDocumentOptions<T>,
): Promise<LoadedDocument<T> | DocumentMiss> {
  const { fetch, modelSlug, siteSlug, guard } = options;
  const base = trimTrailingSlash(options.baseUrl);
  const manifestUrl = `${base}/${modelSlug}/manifest.json`;
  const documentUrl = `${base}/${modelSlug}/sites/${siteSlug}.json`;
  const delayMs = options.retry?.delayMs ?? 1500;
  const sleep = options.retry?.sleep ?? defaultSleep;

  const fetchPair = async () => {
    const [manifest, document] = await Promise.all([
      fetchDocument(fetch, manifestUrl, parseWindgramManifestJson),
      fetchDocument(fetch, documentUrl, guard),
    ]);
    return { manifest, document };
  };

  const first = await fetchPair();
  // The manifest miss wins when both missed: the model not publishing at
  // all is the root cause of its site documents missing too.
  if (isMiss(first.manifest)) return first.manifest;
  if (isMiss(first.document)) return first.document;
  if (runsConsistent(first.manifest, first.document)) {
    return { manifest: first.manifest, document: first.document, stale: false };
  }

  await sleep(delayMs);
  const second = await fetchPair();
  if (!isMiss(second.manifest) && !isMiss(second.document)) {
    return {
      manifest: second.manifest,
      document: second.document,
      stale: !runsConsistent(second.manifest, second.document),
    };
  }
  // The retry lost a document (mid-publish 404 or a torn write): the first
  // pair is the freshest COMPLETE pair seen, reported honestly as stale.
  return { manifest: first.manifest, document: first.document, stale: true };
}

/** `loadProfile`'s options — the shared per-site shape under its long-standing name. */
export type LoadProfileOptions = LoadSiteDocumentOptions;

export interface LoadedProfile {
  manifest: WindgramManifest;
  profile: WindgramProfile;
  /** See `LoadedDocument.stale`: still torn after the retry — a publish is in flight. */
  stale: boolean;
}

/**
 * The profile-typed `loadDocument`: fetches a model's manifest and one
 * site's profile as a consistent pair, with exactly the generic loader's
 * semantics — skew dance, single retry, honest `stale`, discriminated
 * misses, `TransportHttpError` as the only throw.
 */
export async function loadProfile(
  options: LoadProfileOptions,
): Promise<LoadedProfile | DocumentMiss> {
  const loaded = await loadDocument({ ...options, guard: parseWindgramProfileJson });
  if (isMiss(loaded)) return loaded;
  return { manifest: loaded.manifest, profile: loaded.document, stale: loaded.stale };
}

export type LoadSmokeOptions = LoadSiteDocumentOptions;

export interface LoadedSmoke {
  manifest: WindgramManifest;
  smoke: SmokeDocument;
  /** See `LoadedDocument.stale`: still torn after the retry — a publish is in flight. */
  stale: boolean;
}

/**
 * The smoke-typed `loadDocument`: smoke documents carry the same run stamp
 * as profiles and their models publish the same forecast manifest, so they
 * run the identical skew dance — fetch the pair, compare the run, retry
 * once, report a still-torn pair as stale rather than mixing two runs.
 */
export async function loadSmoke(options: LoadSmokeOptions): Promise<LoadedSmoke | DocumentMiss> {
  const loaded = await loadDocument({ ...options, guard: parseSmokeDocumentJson });
  if (isMiss(loaded)) return loaded;
  return { manifest: loaded.manifest, smoke: loaded.document, stale: loaded.stale };
}

/** `loadObservation`'s options: no `retry`, because there is no dance to retry. */
export interface LoadObservationOptions {
  fetch: TransportFetch;
  /** The data-tree root, as for `loadDocument`. */
  baseUrl: string;
  modelSlug: string;
  siteSlug: string;
}

/**
 * Fetches one site's observation document — a guarded SINGLE fetch, no
 * manifest, no skew dance. That is a proof, not an omission:
 *
 * - **There is no pair invariant to defend.** A forecast manifest and its
 *   site documents assert the same run; an observation document has no run
 *   — it is a self-contained rolling window of measured instants, its
 *   identity carried by its own `observed` block. The observation
 *   manifest's `referenceTime` is the newest instant across ALL the
 *   dataset's sites (a max), so manifest-vs-document "skew" of a granule
 *   is the normal state for every site that isn't the newest — a fact of
 *   the aggregate, never a tear.
 * - **The forecast-manifest guard cannot even parse an observation
 *   manifest** (no forecast hours), so the pair dance would have nothing
 *   to compare: pairing here would report every load as invalid.
 * - **The worst case is harmless and un-retryable.** The most a reader can
 *   be behind is one internally-consistent granule — honestly timestamped
 *   by `observed.lastObservedAt` — and a retry cannot beat the CDN's
 *   ~300 s cache anyway. The gap self-heals on the next poll tick.
 *
 * Misses discriminate absent/invalid exactly like `loadDocument`'s;
 * non-404 HTTP errors throw `TransportHttpError`.
 */
export async function loadObservation(
  options: LoadObservationOptions,
): Promise<ObservationDocument | DocumentMiss> {
  const base = trimTrailingSlash(options.baseUrl);
  const documentUrl = `${base}/${options.modelSlug}/sites/${options.siteSlug}.json`;
  return fetchDocument(options.fetch, documentUrl, parseObservationDocumentJson);
}

export interface LoadRunsOptions {
  fetch: TransportFetch;
  /** The data-tree root, as for `loadProfile`. */
  baseUrl: string;
}

/**
 * Fetches data/runs.json — the cross-model run index: per published model,
 * its current run's (referenceTime, generatedAt), keyed by slug. A single
 * document, so there is no pair to tear and no dance; this exists so
 * consumers get the same miss semantics as `loadProfile` (a
 * `DocumentMiss` saying "absent" or "invalid", `TransportHttpError` on
 * other HTTP failures).
 */
export async function loadRuns(options: LoadRunsOptions): Promise<RunsIndex | DocumentMiss> {
  const base = trimTrailingSlash(options.baseUrl);
  return fetchDocument(options.fetch, `${base}/runs.json`, parseRunsIndexJson);
}

/* Documents from the contract guards never carry a "miss" key, so the
   union discriminates on its presence. */
function isMiss<T extends object>(value: T | DocumentMiss): value is DocumentMiss {
  return "miss" in value;
}

async function fetchDocument<T extends object>(
  fetch: TransportFetch,
  url: string,
  guard: (text: string) => T | null,
): Promise<T | DocumentMiss> {
  const response = await fetch(url);
  if (response.status === 404) return { miss: "absent", url };
  if (!response.ok) throw new TransportHttpError(response.status, url);
  const parsed = guard(await response.text());
  return parsed === null ? { miss: "invalid", url } : parsed;
}

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
