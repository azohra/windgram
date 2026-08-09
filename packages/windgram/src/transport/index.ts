/* transport/ — fetching published documents with the runtime's own fetch
   injected. Independently cached manifest and profile objects can represent
   different runs. This module detects that torn read and retries the pair.

   Deliberately I/O-shaped and nothing else:
   - fetch is INJECTED (any WHATWG-compatible fetch: browser, Node, workers,
     undici, a test stub), keeping the core packages I/O-free and this one
     runtime-agnostic;
   - NO storage side effects. No storage API is portable across runtimes;
     callers own cache keys, quotas, invalidation, and stale-data policy.
     `loadProfile` reports staleness and returns the freshest complete pair
     it saw. */

import {
  parseRunsIndexJson,
  parseWindgramManifestJson,
  parseWindgramProfileJson,
  type RunsIndex,
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
 * The pure pair check at the heart of the skew dance: true when the
 * manifest and profile describe the same model AND the same run
 * (referenceTime equality). A pair failing this check is a torn read —
 * two documents from different runs (or different models entirely) that
 * must not be rendered as one forecast.
 */
export function runsConsistent(manifest: WindgramManifest, profile: WindgramProfile): boolean {
  return manifest.model === profile.model && manifest.referenceTime === profile.run.referenceTime;
}

export interface RetryOptions {
  /** Delay before the single retry, ms. Default 1500. */
  delayMs?: number;
  /** Sleep implementation — injectable so tests never actually wait. */
  sleep?: (ms: number) => Promise<void>;
}

export interface LoadProfileOptions {
  fetch: TransportFetch;
  /**
   * The data-tree root, e.g.
   * "https://raw.githubusercontent.com/azohra/windgram/main/data".
   * Trailing slash tolerated.
   */
  baseUrl: string;
  modelSlug: string;
  siteSlug: string;
  retry?: RetryOptions;
}

export interface LoadedProfile {
  manifest: WindgramManifest;
  profile: WindgramProfile;
  /**
   * True when the pair still disagreed about the run after the retry —
   * a publish is in flight and the CDN is mid-sync. Render with a "still
   * syncing" note, or fall back to a pair you cached earlier; never mix
   * the two documents as if they were one forecast.
   */
  stale: boolean;
}

/**
 * Fetches a model's manifest and one site's profile as a consistent pair —
 * the reference-time skew dance: fetch both, compare `referenceTime`, and
 * on disagreement retry the pair once after a short delay (publishes are
 * quick; the CDN usually converges within it). Returns:
 *
 * - `{ manifest, profile, stale: false }` — a consistent pair;
 * - `{ manifest, profile, stale: true }` — the freshest complete pair seen,
 *   still torn after the retry (see `LoadedProfile.stale`);
 * - a `DocumentMiss` — nothing to render, saying WHY: `"absent"` (404 —
 *   the model or site is not published here) or `"invalid"` (the document
 *   exists but failed the contract guard — a contract break or prototype
 *   data, which must not render as garbage and must not hide as a 404).
 *   Discriminate with `"miss" in result`.
 *
 * Non-404 HTTP errors throw `TransportHttpError`. No caching, no storage —
 * see the module docblock for why that stays consumer-side.
 */
export async function loadProfile(
  options: LoadProfileOptions,
): Promise<LoadedProfile | DocumentMiss> {
  const { fetch, modelSlug, siteSlug } = options;
  const base = trimTrailingSlash(options.baseUrl);
  const manifestUrl = `${base}/${modelSlug}/manifest.json`;
  const profileUrl = `${base}/${modelSlug}/sites/${siteSlug}.json`;
  const delayMs = options.retry?.delayMs ?? 1500;
  const sleep = options.retry?.sleep ?? defaultSleep;

  const fetchPair = async () => {
    const [manifest, profile] = await Promise.all([
      fetchDocument(fetch, manifestUrl, parseWindgramManifestJson),
      fetchDocument(fetch, profileUrl, parseWindgramProfileJson),
    ]);
    return { manifest, profile };
  };

  const first = await fetchPair();
  // The manifest miss wins when both missed: the model not publishing at
  // all is the root cause of its site documents missing too.
  if (isMiss(first.manifest)) return first.manifest;
  if (isMiss(first.profile)) return first.profile;
  if (runsConsistent(first.manifest, first.profile)) {
    return { manifest: first.manifest, profile: first.profile, stale: false };
  }

  await sleep(delayMs);
  const second = await fetchPair();
  if (!isMiss(second.manifest) && !isMiss(second.profile)) {
    return {
      manifest: second.manifest,
      profile: second.profile,
      stale: !runsConsistent(second.manifest, second.profile),
    };
  }
  // The retry lost a document (mid-publish 404 or a torn write): the first
  // pair is the freshest COMPLETE pair seen, reported honestly as stale.
  return { manifest: first.manifest, profile: first.profile, stale: true };
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
