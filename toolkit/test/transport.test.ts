import { describe, expect, it } from "vitest";
import type { WindgramManifest, WindgramProfile } from "../src/contract/index.js";
import {
  loadProfile,
  loadRuns,
  runsConsistent,
  TransportHttpError,
  type DocumentMiss,
  type TransportResponse,
} from "../src/transport/index.js";
import { deterministicProfile, manifest, runsIndex } from "./fixtures.js";

/** Narrow a load result to its hit; a miss fails the test loudly. */
function hit<T extends object>(result: T | DocumentMiss): T {
  if ("miss" in result) throw new Error(`unexpected miss: ${JSON.stringify(result)}`);
  return result;
}

const BASE = "https://example.test/data";
const MANIFEST_URL = `${BASE}/hrdps-continental/manifest.json`;
const PROFILE_URL = `${BASE}/hrdps-continental/sites/dundee.json`;

function ok(body: unknown): TransportResponse {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

function status(code: number): TransportResponse {
  return { ok: false, status: code, text: async () => "" };
}

/* A scripted fetch: each URL serves its queued responses in order, sticking
   on the last one — so a test can express "torn on the first pair, converged
   on the second" as data. Records calls for assertions. */
function stubFetch(script: Record<string, TransportResponse[]>) {
  const calls: string[] = [];
  const served = new Map<string, number>();
  const fetch = async (url: string): Promise<TransportResponse> => {
    calls.push(url);
    const queue = script[url];
    if (!queue || queue.length === 0) return status(404);
    const index = Math.min(served.get(url) ?? 0, queue.length - 1);
    served.set(url, index + 1);
    return queue[index];
  };
  return { fetch, calls };
}

function pair(referenceTime: string): { manifest: WindgramManifest; profile: WindgramProfile } {
  const taggedManifest = { ...manifest(), referenceTime };
  const profile = deterministicProfile();
  const taggedProfile = { ...profile, run: { ...profile.run, referenceTime } };
  return { manifest: taggedManifest, profile: taggedProfile };
}

const noWait = { delayMs: 0, sleep: async () => {} };

describe("runsConsistent", () => {
  it("is true exactly when model and referenceTime agree", () => {
    const { manifest: m, profile: p } = pair("2026-08-08T00:00:00Z");
    expect(runsConsistent(m, p)).toBe(true);
    expect(runsConsistent({ ...m, referenceTime: "2026-08-08T06:00:00Z" }, p)).toBe(false);
    expect(runsConsistent({ ...m, model: "gfs" }, p)).toBe(false);
  });
});

describe("loadProfile", () => {
  it("returns a consistent pair first try without retrying", async () => {
    const run = pair("2026-08-08T00:00:00Z");
    const { fetch, calls } = stubFetch({
      [MANIFEST_URL]: [ok(run.manifest)],
      [PROFILE_URL]: [ok(run.profile)],
    });
    const loaded = await loadProfile({
      fetch,
      baseUrl: BASE,
      modelSlug: "hrdps-continental",
      siteSlug: "dundee",
    });
    const pairLoaded = hit(loaded);
    expect(pairLoaded.stale).toBe(false);
    expect(pairLoaded.manifest.referenceTime).toBe("2026-08-08T00:00:00Z");
    expect(calls).toHaveLength(2); // no retry on a clean pair
  });

  it("recovers from a torn read when the retry converges", async () => {
    const oldRun = pair("2026-08-08T00:00:00Z");
    const newRun = pair("2026-08-08T06:00:00Z");
    const { fetch, calls } = stubFetch({
      [MANIFEST_URL]: [ok(newRun.manifest), ok(newRun.manifest)],
      [PROFILE_URL]: [ok(oldRun.profile), ok(newRun.profile)], // CDN caught up
    });
    const loaded = await loadProfile({
      fetch,
      baseUrl: BASE,
      modelSlug: "hrdps-continental",
      siteSlug: "dundee",
      retry: noWait,
    });
    const pairLoaded = hit(loaded);
    expect(pairLoaded.stale).toBe(false);
    expect(pairLoaded.profile.run.referenceTime).toBe("2026-08-08T06:00:00Z");
    expect(calls).toHaveLength(4); // pair + one retried pair, never more
  });

  it("reports stale honestly when the tear outlives the single retry", async () => {
    const oldRun = pair("2026-08-08T00:00:00Z");
    const newRun = pair("2026-08-08T06:00:00Z");
    const { fetch, calls } = stubFetch({
      [MANIFEST_URL]: [ok(newRun.manifest)],
      [PROFILE_URL]: [ok(oldRun.profile)], // stuck on the old run
    });
    const loaded = await loadProfile({
      fetch,
      baseUrl: BASE,
      modelSlug: "hrdps-continental",
      siteSlug: "dundee",
      retry: noWait,
    });
    const pairLoaded = hit(loaded);
    expect(pairLoaded.stale).toBe(true);
    // The freshest complete pair is returned for the caller to judge.
    expect(pairLoaded.manifest.referenceTime).toBe("2026-08-08T06:00:00Z");
    expect(pairLoaded.profile.run.referenceTime).toBe("2026-08-08T00:00:00Z");
    expect(calls).toHaveLength(4);
  });

  it("falls back to the first complete pair when the retry loses a document", async () => {
    const oldRun = pair("2026-08-08T00:00:00Z");
    const newRun = pair("2026-08-08T06:00:00Z");
    const { fetch } = stubFetch({
      [MANIFEST_URL]: [ok(newRun.manifest), ok(newRun.manifest)],
      [PROFILE_URL]: [ok(oldRun.profile), status(404)], // mid-publish gap
    });
    const loaded = await loadProfile({
      fetch,
      baseUrl: BASE,
      modelSlug: "hrdps-continental",
      siteSlug: "dundee",
      retry: noWait,
    });
    const pairLoaded = hit(loaded);
    expect(pairLoaded.stale).toBe(true);
    expect(pairLoaded.profile.run.referenceTime).toBe("2026-08-08T00:00:00Z");
  });

  it("waits the configured delay (and only on a torn read)", async () => {
    const oldRun = pair("2026-08-08T00:00:00Z");
    const newRun = pair("2026-08-08T06:00:00Z");
    const waits: number[] = [];
    const { fetch } = stubFetch({
      [MANIFEST_URL]: [ok(newRun.manifest), ok(newRun.manifest)],
      [PROFILE_URL]: [ok(oldRun.profile), ok(newRun.profile)],
    });
    await loadProfile({
      fetch,
      baseUrl: BASE,
      modelSlug: "hrdps-continental",
      siteSlug: "dundee",
      retry: {
        delayMs: 250,
        sleep: async (ms) => {
          waits.push(ms);
        },
      },
    });
    expect(waits).toEqual([250]);
  });

  it("reports a 404 as an 'absent' miss naming the missing document", async () => {
    const run = pair("2026-08-08T00:00:00Z");
    const noManifest = stubFetch({ [PROFILE_URL]: [ok(run.profile)] });
    expect(
      await loadProfile({
        fetch: noManifest.fetch,
        baseUrl: BASE,
        modelSlug: "hrdps-continental",
        siteSlug: "dundee",
      }),
    ).toEqual({ miss: "absent", url: MANIFEST_URL });
    const noProfile = stubFetch({ [MANIFEST_URL]: [ok(run.manifest)] });
    expect(
      await loadProfile({
        fetch: noProfile.fetch,
        baseUrl: BASE,
        modelSlug: "hrdps-continental",
        siteSlug: "dundee",
      }),
    ).toEqual({ miss: "absent", url: PROFILE_URL });
  });

  it("reports a guard failure as an 'invalid' miss — a contract break must not hide as a 404", async () => {
    const run = pair("2026-08-08T00:00:00Z");
    const { fetch } = stubFetch({
      [MANIFEST_URL]: [ok(run.manifest)],
      [PROFILE_URL]: [ok({ prototype: true })],
    });
    expect(
      await loadProfile({
        fetch,
        baseUrl: BASE,
        modelSlug: "hrdps-continental",
        siteSlug: "dundee",
      }),
    ).toEqual({ miss: "invalid", url: PROFILE_URL });
  });

  it("throws TransportHttpError on non-404 failures instead of masking them", async () => {
    const run = pair("2026-08-08T00:00:00Z");
    const { fetch } = stubFetch({
      [MANIFEST_URL]: [status(503)],
      [PROFILE_URL]: [ok(run.profile)],
    });
    await expect(
      loadProfile({ fetch, baseUrl: BASE, modelSlug: "hrdps-continental", siteSlug: "dundee" }),
    ).rejects.toThrow(TransportHttpError);
  });

  it("tolerates a trailing slash on baseUrl", async () => {
    const run = pair("2026-08-08T00:00:00Z");
    const { fetch, calls } = stubFetch({
      [MANIFEST_URL]: [ok(run.manifest)],
      [PROFILE_URL]: [ok(run.profile)],
    });
    const loaded = await loadProfile({
      fetch,
      baseUrl: `${BASE}/`,
      modelSlug: "hrdps-continental",
      siteSlug: "dundee",
    });
    expect(loaded).not.toBeNull();
    expect(calls).toContain(MANIFEST_URL);
  });
});

describe("loadRuns", () => {
  it("loads and guards the run index", async () => {
    const { fetch } = stubFetch({ [`${BASE}/runs.json`]: [ok(runsIndex())] });
    const runs = await loadRuns({ fetch, baseUrl: BASE });
    const index = hit(runs);
    expect(index.runs["reps"]!.referenceTime).toBe("2026-08-07T12:00:00Z");
  });

  it("misses discriminate absent from invalid, and other HTTP errors still throw", async () => {
    const missing = stubFetch({});
    expect(await loadRuns({ fetch: missing.fetch, baseUrl: BASE })).toEqual({
      miss: "absent",
      url: `${BASE}/runs.json`,
    });
    const invalid = stubFetch({ [`${BASE}/runs.json`]: [ok({ runs: [] })] });
    expect(await loadRuns({ fetch: invalid.fetch, baseUrl: BASE })).toEqual({
      miss: "invalid",
      url: `${BASE}/runs.json`,
    });
    const failing = stubFetch({ [`${BASE}/runs.json`]: [status(500)] });
    await expect(loadRuns({ fetch: failing.fetch, baseUrl: BASE })).rejects.toThrow(
      TransportHttpError,
    );
  });
});
