/* transport/ — fetching published documents correctly, with the runtime's
   own fetch injected. The dataset is static JSON behind a CDN whose cache
   entries expire independently (raw.githubusercontent holds files ~5
   minutes), so a manifest and a site profile fetched together can come from
   two different runs — the "torn read" every naive pair fetch eventually
   hits. This module owns the reference-time skew dance so consumers don't
   reinvent it wrong; research/static-forecast-pipeline.md documents the
   publication side of the same contract.

   Deliberately I/O-shaped and nothing else:
   - fetch is INJECTED (any WHATWG-compatible fetch: browser, Node, workers,
     undici, a test stub), keeping the core packages I/O-free and this one
     runtime-agnostic;
   - NO storage side effects. The site layers a sessionStorage last-known-
     good fallback on top of this; the package does not, because no storage
     API is portable across runtimes and cache doctrine — keys, quotas,
     invalidation, whether a stale pair is better than none — is consumer
     policy, not transport fact. `loadProfile` therefore reports staleness
     honestly and returns the freshest complete pair it saw; what to do
     with a stale pair is the caller's call. */

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
 * - `null` — the model or site is not published here: a 404, or a body
 *   that fails the contract guards (a model still publishing pre-release
 *   prototype data reads as unavailable, exactly like a 404, rather than
 *   rendering garbage).
 *
 * Non-404 HTTP errors throw `TransportHttpError`. No caching, no storage —
 * see the module docblock for why that stays consumer-side.
 */
export async function loadProfile(options: LoadProfileOptions): Promise<LoadedProfile | null> {
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
  if (first.manifest === null || first.profile === null) return null;
  if (runsConsistent(first.manifest, first.profile)) {
    return { manifest: first.manifest, profile: first.profile, stale: false };
  }

  await sleep(delayMs);
  const second = await fetchPair();
  if (second.manifest !== null && second.profile !== null) {
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
 * consumers get the same 404/guard semantics as `loadProfile` (null when
 * absent or failing the contract, `TransportHttpError` on other HTTP
 * failures).
 */
export async function loadRuns(options: LoadRunsOptions): Promise<RunsIndex | null> {
  const base = trimTrailingSlash(options.baseUrl);
  return fetchDocument(options.fetch, `${base}/runs.json`, parseRunsIndexJson);
}

async function fetchDocument<T>(
  fetch: TransportFetch,
  url: string,
  guard: (text: string) => T | null,
): Promise<T | null> {
  const response = await fetch(url);
  if (response.status === 404) return null;
  if (!response.ok) throw new TransportHttpError(response.status, url);
  return guard(await response.text());
}

function trimTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
