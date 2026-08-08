import {
  parseWindgramManifestJson,
  parseWindgramProfileJson,
  type ModelEntry,
  type WindgramManifest,
  type WindgramProfile,
} from "windgram/contract";

// Overridable so a dev server (or another frontend) can point at a local
// or mirrored data tree; the published GitHub tree is the default.
export const DATA_BASE =
  import.meta.env.PUBLIC_DATA_BASE ?? "https://raw.githubusercontent.com/azohra/windgram/main";

export interface SiteCatalogEntry {
  slug: string;
  name: string;
  latitude: number;
  longitude: number;
  elevationM: number;
}

async function fetchJSON<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new HttpError(res.status, url);
  }
  return (await res.json()) as T;
}

/* Published documents cross a trust boundary: the contract's parse guards
   decide what a windgram is. A model still publishing pre-release prototype
   data fails the guard and reads as null — exactly like a 404 — so it
   simply shows as unavailable rather than rendering garbage. */
async function fetchGuarded<T>(url: string, guard: (text: string) => T | null): Promise<T | null> {
  const res = await fetch(url, { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new HttpError(res.status, url);
  return guard(await res.text());
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public url: string,
  ) {
    super(`${status} fetching ${url}`);
  }
}

export function manifestUrl(model: ModelEntry): string {
  return `${DATA_BASE}/data/${model.slug}/manifest.json`;
}

export function siteProfileUrl(model: ModelEntry, slug: string): string {
  return `${DATA_BASE}/data/${model.slug}/sites/${slug}.json`;
}

export async function fetchSitesCatalog(): Promise<SiteCatalogEntry[]> {
  return fetchJSON<SiteCatalogEntry[]>(`${DATA_BASE}/sites.json`);
}

/** Null when the model has no readable manifest (404 or pre-release prototype data). */
export async function fetchManifest(model: ModelEntry): Promise<WindgramManifest | null> {
  return fetchGuarded(manifestUrl(model), parseWindgramManifestJson);
}

/** Null when the site isn't published for this model, or the data fails the guard. */
export async function fetchSiteProfile(
  model: ModelEntry,
  slug: string,
): Promise<WindgramProfile | null> {
  return fetchGuarded(siteProfileUrl(model, slug), parseWindgramProfileJson);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface CachedPair {
  manifest: WindgramManifest;
  profile: WindgramProfile;
}

function cacheKey(modelSlug: string, slug: string): string {
  return `windgram:${modelSlug}:${slug}`;
}

function cacheGet(key: string): CachedPair | null {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as CachedPair) : null;
  } catch {
    return null;
  }
}

function cacheSet(key: string, value: CachedPair): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private browsing or quota — the guard degrades to no-cache, not a crash */
  }
}

export interface GuardedFetch {
  manifest: WindgramManifest;
  profile: WindgramProfile;
  /**
   * True when the manifest and site file came from two different runs and
   * didn't converge after a retry — see research/static-forecast-pipeline.md's
   * "reference-time skew guard". The caller should show a "still syncing"
   * note rather than silently mixing two runs.
   */
  stale: boolean;
}

/**
 * Fetches a model's manifest and one site's profile together, enforcing the
 * reference-time skew guard the pipeline's docs specify: raw.githubusercontent's
 * ~5-minute cache means a manifest and a site file can briefly disagree about
 * which run is current. On disagreement, retry once, then fall back to the
 * last known-good pair for this model+site rather than render a mismatch.
 * Returns null when the model has no readable data for the site.
 */
export async function fetchProfileWithSkewGuard(
  model: ModelEntry,
  slug: string,
): Promise<GuardedFetch | null> {
  const key = cacheKey(model.slug, slug);
  const manifest = await fetchManifest(model);
  if (!manifest) return null;
  if (!manifest.sites.some((s) => s.slug === slug)) return null;

  const profile = await fetchSiteProfile(model, slug);
  if (!profile) return null;

  if (profile.run.referenceTime === manifest.referenceTime) {
    cacheSet(key, { manifest, profile });
    return { manifest, profile, stale: false };
  }

  await sleep(1500);
  const [manifest2, profile2] = await Promise.all([
    fetchManifest(model),
    fetchSiteProfile(model, slug),
  ]);
  if (manifest2 && profile2 && manifest2.referenceTime === profile2.run.referenceTime) {
    cacheSet(key, { manifest: manifest2, profile: profile2 });
    return { manifest: manifest2, profile: profile2, stale: false };
  }

  const cached = cacheGet(key);
  if (cached) return { ...cached, stale: true };
  return { manifest, profile, stale: true };
}
