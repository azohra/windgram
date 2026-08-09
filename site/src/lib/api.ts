import {
  parseSitesCatalogueJson,
  type ModelEntry,
  type SiteCatalogueEntry,
  type WindgramManifest,
  type WindgramProfile,
} from "windgram/contract";
import { loadProfile, type LoadedProfile, type TransportFetch } from "windgram/transport";

// Overridable so a dev server (or another frontend) can point at a local
// or mirrored data tree; the published GitHub tree is the default.
export const DATA_BASE =
  import.meta.env.PUBLIC_DATA_BASE ?? "https://raw.githubusercontent.com/azohra/windgram/main";

// The data tree the transport reads (manifests, profiles, runs.json) lives
// under data/; sites.json sits beside it at the repository root.
const DATA_TREE = `${DATA_BASE}/data`;

/* The transport takes the runtime's own fetch; the browser's, pinned to
   no-store so the CDN's cache is the only cache in play. */
const noStoreFetch: TransportFetch = (url) => fetch(url, { cache: "no-store" });

/**
 * The root sites.json catalogue — `{schemaVersion, sites}` since the 0.3.0
 * wave, guarded by the package contract so an unreadable catalogue fails
 * loudly instead of populating a picker with garbage.
 */
export async function fetchSitesCatalog(): Promise<SiteCatalogueEntry[]> {
  const url = `${DATA_BASE}/sites.json`;
  const res = await noStoreFetch(url);
  if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
  const catalogue = parseSitesCatalogueJson(await res.text());
  if (!catalogue) throw new Error(`sites.json failed the contract guard (${url})`);
  return catalogue.sites;
}

export type { LoadedProfile } from "windgram/transport";

/* The package transport owns the reference-time skew dance and deliberately
   carries no storage; a last-known-good pair per model+site is this site's
   cache doctrine, layered around it here. */

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

/**
 * Fetches a model's manifest and one site's profile as a consistent pair via
 * the package transport (`loadProfile` runs the skew retry itself), falling
 * back to this session's last known-good pair when the CDN is still torn
 * after the retry. Null when the model or site is not published (404, or a
 * body failing the contract guards).
 */
export async function fetchProfile(
  model: ModelEntry,
  slug: string,
): Promise<LoadedProfile | null> {
  const key = cacheKey(model.slug, slug);
  const loaded = await loadProfile({
    fetch: noStoreFetch,
    baseUrl: DATA_TREE,
    modelSlug: model.slug,
    siteSlug: slug,
  });
  if (!loaded) return null;
  if (!loaded.stale) {
    cacheSet(key, { manifest: loaded.manifest, profile: loaded.profile });
    return loaded;
  }
  const cached = cacheGet(key);
  return cached ? { ...cached, stale: true } : loaded;
}
