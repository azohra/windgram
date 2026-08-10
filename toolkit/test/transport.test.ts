import { describe, expect, it } from "vitest";
import type {
  ObservationDocument,
  SmokeDocument,
  WindgramManifest,
  WindgramProfile,
} from "../src/contract/index.js";
import {
  parseSmokeDocumentJson,
  parseWindgramProfileJson,
} from "../src/contract/index.js";
import {
  loadObservation,
  loadProfile,
  loadRuns,
  loadSiteSet,
  loadSmoke,
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

const SMOKE_MANIFEST_URL = `${BASE}/raqdps/manifest.json`;
const SMOKE_URL = `${BASE}/raqdps/sites/dundee.json`;

function smokePair(referenceTime: string): {
  manifest: WindgramManifest;
  smoke: SmokeDocument;
} {
  return {
    manifest: { ...manifest(), model: "raqdps", referenceTime },
    smoke: {
      schemaVersion: 1,
      model: "raqdps",
      run: { referenceTime, generatedAt: "2026-08-08T04:47:14Z" },
      site: { id: "dundee", name: "Dundee", latitude: 49.291977, longitude: -117.183569 },
      hours: [
        {
          validAt: "2026-08-08T18:00:00Z",
          pm25Ugm3: 40,
          smokePlumeSurfaceUgm3: 37.5,
          smokePlumeColumnMgm2: 200,
        },
      ],
    },
  };
}

describe("loadSmoke", () => {
  it("runs the same skew dance as loadProfile: a torn pair reads stale, a converging retry heals", async () => {
    const oldRun = smokePair("2026-08-08T00:00:00Z");
    const newRun = smokePair("2026-08-08T12:00:00Z");

    // Torn past the retry: honest stale, freshest complete pair returned.
    const torn = stubFetch({
      [SMOKE_MANIFEST_URL]: [ok(newRun.manifest)],
      [SMOKE_URL]: [ok(oldRun.smoke)], // stuck on the old run
    });
    const stale = hit(
      await loadSmoke({
        fetch: torn.fetch,
        baseUrl: BASE,
        modelSlug: "raqdps",
        siteSlug: "dundee",
        retry: noWait,
      }),
    );
    expect(stale.stale).toBe(true);
    expect(stale.manifest.referenceTime).toBe("2026-08-08T12:00:00Z");
    expect(stale.smoke.run.referenceTime).toBe("2026-08-08T00:00:00Z");
    expect(torn.calls).toHaveLength(4); // pair + one retried pair, never more

    // Converging retry: the healed pair reads clean.
    const healing = stubFetch({
      [SMOKE_MANIFEST_URL]: [ok(newRun.manifest), ok(newRun.manifest)],
      [SMOKE_URL]: [ok(oldRun.smoke), ok(newRun.smoke)], // CDN caught up
    });
    const healed = hit(
      await loadSmoke({
        fetch: healing.fetch,
        baseUrl: BASE,
        modelSlug: "raqdps",
        siteSlug: "dundee",
        retry: noWait,
      }),
    );
    expect(healed.stale).toBe(false);
    expect(healed.smoke.run.referenceTime).toBe("2026-08-08T12:00:00Z");
  });

  it("rejects a document that fails the smoke guard as an 'invalid' miss", async () => {
    const run = smokePair("2026-08-08T00:00:00Z");
    const { fetch } = stubFetch({
      [SMOKE_MANIFEST_URL]: [ok(run.manifest)],
      // A profile is not a smoke document: the typed guard must refuse it.
      [SMOKE_URL]: [ok(deterministicProfile())],
    });
    expect(
      await loadSmoke({ fetch, baseUrl: BASE, modelSlug: "raqdps", siteSlug: "dundee" }),
    ).toEqual({ miss: "invalid", url: SMOKE_URL });
  });
});

const OBSERVATION_URL = `${BASE}/goes18-dsr/sites/dundee.json`;

function observationDocument(): ObservationDocument {
  return {
    schemaVersion: 1,
    model: "goes18-dsr",
    observed: {
      firstObservedAt: "2026-08-09T15:00:00Z",
      lastObservedAt: "2026-08-10T02:00:00Z",
      generatedAt: "2026-08-10T02:31:12Z",
    },
    site: { id: "dundee", name: "Dundee", latitude: 49.291977, longitude: -117.183569 },
    observations: [{ observedAt: "2026-08-09T15:00:00Z", downwardShortwaveWm2: 112.4 }],
  };
}

describe("loadObservation", () => {
  it("is a single guarded fetch — no manifest request, no pair, no retry", async () => {
    const { fetch, calls } = stubFetch({ [OBSERVATION_URL]: [ok(observationDocument())] });
    const loaded = hit(
      await loadObservation({ fetch, baseUrl: BASE, modelSlug: "goes18-dsr", siteSlug: "dundee" }),
    );
    expect(loaded.observed.lastObservedAt).toBe("2026-08-10T02:00:00Z");
    // The one document is the whole load: no manifest.json ever requested.
    expect(calls).toEqual([OBSERVATION_URL]);
  });

  it("misses discriminate absent from invalid, and other HTTP errors still throw", async () => {
    const missing = stubFetch({});
    expect(
      await loadObservation({
        fetch: missing.fetch,
        baseUrl: BASE,
        modelSlug: "goes18-dsr",
        siteSlug: "dundee",
      }),
    ).toEqual({ miss: "absent", url: OBSERVATION_URL });

    // A forecast-shaped document must not pass the observation guard.
    const invalid = stubFetch({ [OBSERVATION_URL]: [ok(deterministicProfile())] });
    expect(
      await loadObservation({
        fetch: invalid.fetch,
        baseUrl: BASE,
        modelSlug: "goes18-dsr",
        siteSlug: "dundee",
      }),
    ).toEqual({ miss: "invalid", url: OBSERVATION_URL });

    const failing = stubFetch({ [OBSERVATION_URL]: [status(503)] });
    await expect(
      loadObservation({
        fetch: failing.fetch,
        baseUrl: BASE,
        modelSlug: "goes18-dsr",
        siteSlug: "dundee",
      }),
    ).rejects.toThrow(TransportHttpError);
  });
});

describe("loadSiteSet", () => {
  const RED_URL = `${BASE}/hrdps-continental/sites/red-mountain.json`;
  const SLUGS = ["dundee", "red-mountain"] as const;

  function profileFor(siteSlug: string, referenceTime: string): WindgramProfile {
    const profile = deterministicProfile();
    return {
      ...profile,
      run: { ...profile.run, referenceTime },
      site: { ...profile.site, id: siteSlug },
    };
  }

  function load(fetch: (url: string) => Promise<TransportResponse>) {
    return loadSiteSet({
      fetch,
      baseUrl: BASE,
      modelSlug: "hrdps-continental",
      siteSlugs: SLUGS,
      guard: parseWindgramProfileJson,
      retry: noWait,
    });
  }

  /** Narrow to the coherent arm; anything else fails the test loudly. */
  function coherent(result: Awaited<ReturnType<typeof load>>) {
    if ("miss" in result || result.syncing) {
      throw new Error(`expected a coherent set: ${JSON.stringify(result)}`);
    }
    return result;
  }

  it("returns a coherent set anchored on one manifest fetch", async () => {
    const run = pair("2026-08-08T06:00:00Z");
    const { fetch, calls } = stubFetch({
      [MANIFEST_URL]: [ok(run.manifest)],
      [PROFILE_URL]: [ok(profileFor("dundee", "2026-08-08T06:00:00Z"))],
      [RED_URL]: [ok(profileFor("red-mountain", "2026-08-08T06:00:00Z"))],
    });
    const set = coherent(await load(fetch));
    expect(set.referenceTime).toBe("2026-08-08T06:00:00Z");
    expect(Object.keys(set.documents).sort()).toEqual(["dundee", "red-mountain"]);
    expect(set.misses).toEqual({});
    // One manifest anchors the whole set: three fetches, no per-pair dance.
    expect(calls).toHaveLength(3);
    expect(calls.filter((url) => url === MANIFEST_URL)).toHaveLength(1);
  });

  it("heals a mid-publish mix by refetching the manifest and only the disagreeing documents", async () => {
    const { fetch, calls } = stubFetch({
      [MANIFEST_URL]: [ok(pair("2026-08-08T06:00:00Z").manifest)],
      [PROFILE_URL]: [
        ok(profileFor("dundee", "2026-08-08T00:00:00Z")), // one run behind
        ok(profileFor("dundee", "2026-08-08T06:00:00Z")), // CDN caught up
      ],
      [RED_URL]: [ok(profileFor("red-mountain", "2026-08-08T06:00:00Z"))],
    });
    const set = coherent(await load(fetch));
    expect(set.referenceTime).toBe("2026-08-08T06:00:00Z");
    expect(set.documents["dundee"]!.run.referenceTime).toBe("2026-08-08T06:00:00Z");
    // The agreeing document is NOT refetched: 3 first-pass + manifest + dundee.
    expect(calls).toHaveLength(5);
    expect(calls.filter((url) => url === RED_URL)).toHaveLength(1);
  });

  it("reports a set still mixing runs after the retry as syncing, naming the runs seen", async () => {
    const { fetch } = stubFetch({
      [MANIFEST_URL]: [ok(pair("2026-08-08T06:00:00Z").manifest)],
      [PROFILE_URL]: [ok(profileFor("dundee", "2026-08-08T00:00:00Z"))], // stuck
      [RED_URL]: [ok(profileFor("red-mountain", "2026-08-08T06:00:00Z"))],
    });
    const result = await load(fetch);
    expect(result).toEqual({
      syncing: true,
      runsSeen: ["2026-08-08T00:00:00Z", "2026-08-08T06:00:00Z"],
    });
  });

  it("treats an all-old coherent set as the previous publication, not as syncing", async () => {
    // runs.json may already announce a newer run; this model's tree hasn't
    // synced yet but IS internally coherent — honestly the previous forecast.
    const { fetch, calls } = stubFetch({
      [MANIFEST_URL]: [ok(pair("2026-08-08T00:00:00Z").manifest)],
      [PROFILE_URL]: [ok(profileFor("dundee", "2026-08-08T00:00:00Z"))],
      [RED_URL]: [ok(profileFor("red-mountain", "2026-08-08T00:00:00Z"))],
    });
    const set = coherent(await load(fetch));
    expect(set.referenceTime).toBe("2026-08-08T00:00:00Z");
    expect(calls).toHaveLength(3); // coherent first pass: nothing to retry
  });

  it("keeps per-site misses discriminated without poisoning the set", async () => {
    const run = pair("2026-08-08T06:00:00Z");
    const { fetch } = stubFetch({
      [MANIFEST_URL]: [ok(run.manifest)],
      [PROFILE_URL]: [ok({ prototype: true })], // exists, fails the guard
      // red-mountain: absent (404) — outside the model's domain.
    });
    const set = coherent(await load(fetch));
    expect(set.documents).toEqual({});
    expect(set.misses).toEqual({
      dundee: { miss: "invalid", url: PROFILE_URL },
      "red-mountain": { miss: "absent", url: RED_URL },
    });
  });

  it("returns the manifest miss when the model publishes nothing, and still throws on HTTP failures", async () => {
    const missing = stubFetch({});
    expect(await load(missing.fetch)).toEqual({ miss: "absent", url: MANIFEST_URL });

    const failing = stubFetch({ [MANIFEST_URL]: [status(503)] });
    await expect(load(failing.fetch)).rejects.toThrow(TransportHttpError);
  });

  it("anchors smoke documents the same way via the guard parameter", async () => {
    const run = smokePair("2026-08-08T12:00:00Z");
    const { fetch } = stubFetch({
      [SMOKE_MANIFEST_URL]: [ok(run.manifest)],
      [SMOKE_URL]: [ok(run.smoke)],
    });
    const result = await loadSiteSet({
      fetch,
      baseUrl: BASE,
      modelSlug: "raqdps",
      siteSlugs: ["dundee"],
      guard: parseSmokeDocumentJson,
      retry: noWait,
    });
    if ("miss" in result || result.syncing) throw new Error("expected a coherent smoke set");
    expect(result.documents["dundee"]!.hours[0]!.smokePlumeColumnMgm2).toBe(200);
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
