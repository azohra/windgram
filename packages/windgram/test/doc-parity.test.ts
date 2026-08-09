import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../src/contract/index.js";
import { DRY_ADIABATIC_LAPSE_C_PER_M } from "../src/derive/index.js";
import { DEFAULT_CAPE_CLASSES } from "../src/scene/index.js";

/* Doc-parity: hand-written facts in documentation prose, asserted against
   their authorities. The portal already imports most package constants at
   build time (npm version, SCHEMA_VERSION table row, vocabulary versions,
   DEFAULT_ANALYZE_THRESHOLDS, token maps) — those cannot rot and are not
   re-checked here. What remains hand-written are the claims below: repo
   metadata files that cannot import anything (CITATION.cff), the Python
   pipeline version, and prose that restates module-private defaults.

   Each assertion anchors on a small, distinctive snippet of the documented
   claim. If one of these anchors stops matching because the prose was
   reworded, update the anchor to the new wording — do not delete the
   assertion; the claim it guards is still a claim. */

const repoRoot = join(__dirname, "..", "..", "..");
const read = (...segments: string[]) => readFileSync(join(repoRoot, ...segments), "utf-8");

/** Match `pattern` in `text` or fail with a message naming the missing anchor. */
function anchor(text: string, pattern: RegExp, where: string): RegExpMatchArray {
  const match = text.match(pattern);
  if (!match) {
    throw new Error(
      `doc-parity anchor not found in ${where}: ${pattern}\n` +
        "If the prose was reworded, update this anchor to the new wording; " +
        "the documented fact still needs its parity check.",
    );
  }
  return match;
}

/** Parse a documented number: strips thousands commas, accepts U+2212 minus. */
const num = (text: string) => Number(text.replace(/,/g, "").replace(/−/g, "-"));

const NUMBER_WORDS: Record<string, number> = {
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

const packageVersion: string = JSON.parse(read("packages", "windgram", "package.json")).version;

describe("doc parity: versions", () => {
  it("CITATION.cff cites the released package version", () => {
    const cited = anchor(read("CITATION.cff"), /^version: (\S+)$/m, "CITATION.cff")[1];
    expect(cited).toBe(packageVersion);
  });

  it("versioning.mdx states the Python pipeline version from pyproject.toml", () => {
    // Authority: pyproject.toml [project] version — the portal agent left
    // this hand-written because the site does not import Python metadata.
    const projectSection = anchor(
      read("pyproject.toml"),
      /\[project\]([\s\S]*?)(?=\n\[|$)/,
      "pyproject.toml [project] section",
    )[1];
    const pyVersion = anchor(
      projectSection,
      /^version = "([^"]+)"$/m,
      "pyproject.toml [project] version",
    )[1];

    const versioning = read("site", "src", "content", "docs", "docs", "data", "versioning.mdx");
    const tableRow = anchor(
      versioning,
      /\| Python pipeline \| `([^`]+)` \|/,
      "versioning.mdx axis table (Python pipeline row)",
    )[1];
    expect(tableRow).toBe(pyVersion);

    const prose = anchor(
      versioning,
      /records Python project version\s+`([^`]+)`/,
      "versioning.mdx Python compatibility prose",
    )[1];
    expect(prose).toBe(pyVersion);

    const aside = anchor(
      versioning,
      /Python `([^`]+)` does not mean profile schema/,
      "versioning.mdx do-not-compare aside",
    )[1];
    expect(aside).toBe(pyVersion);
  });

  it("versioning.mdx's hand-written schemaVersion claims match SCHEMA_VERSION", () => {
    // The axis table imports SCHEMA_VERSION; these two compatibility
    // sentences state the number in prose.
    const versioning = read("site", "src", "content", "docs", "docs", "data", "versioning.mdx");
    const current = anchor(
      versioning,
      /uses `schemaVersion: (\d+)`/,
      "versioning.mdx 'every current document uses' sentence",
    )[1];
    expect(num(current)).toBe(SCHEMA_VERSION);

    const release = anchor(
      versioning,
      /published profiles at `schemaVersion: (\d+)`/,
      "versioning.mdx current-release sentence",
    )[1];
    expect(num(release)).toBe(SCHEMA_VERSION);
  });
});

describe("doc parity: transport retry default", () => {
  // Authority: the module-private `options.retry?.delayMs ?? <n>` default in
  // loadProfile (packages/windgram/src/transport/index.ts) — not exported,
  // so both the doc page and the JSDoc restate the number.
  const transportSrc = read("packages", "windgram", "src", "transport", "index.ts");
  const sourceDefault = num(
    anchor(
      transportSrc,
      /options\.retry\?\.delayMs \?\? (\d+)/,
      "src/transport/index.ts loadProfile delay default",
    )[1],
  );

  it("transport.mdx states the source's retry delay", () => {
    const doc = read("site", "src", "content", "docs", "docs", "typescript", "transport.mdx");
    const stated = num(anchor(doc, /\((\d+) ms by\s+default/, "typescript/transport.mdx")[1]);
    expect(stated).toBe(sourceDefault);
  });

  it("the RetryOptions JSDoc states the same delay", () => {
    const stated = num(
      anchor(
        transportSrc,
        /Delay before the single retry, ms\. Default (\d+)\./,
        "src/transport/index.ts RetryOptions.delayMs JSDoc",
      )[1],
    );
    expect(stated).toBe(sourceDefault);
  });
});

describe("doc parity: day-window defaults", () => {
  it("derivation-science.mdx states the derive day-window defaults", () => {
    // Authority: module-private DEFAULT_DAY_START_HOUR / DEFAULT_DAY_END_HOUR /
    // DEFAULT_MIN_HOURS_PER_DAY in packages/windgram/src/derive/day-window.ts.
    const dayWindowSrc = read("packages", "windgram", "src", "derive", "day-window.ts");
    const startHour = num(
      anchor(dayWindowSrc, /const DEFAULT_DAY_START_HOUR = (\d+);/, "day-window.ts")[1],
    );
    const endHour = num(
      anchor(dayWindowSrc, /const DEFAULT_DAY_END_HOUR = (\d+);/, "day-window.ts")[1],
    );
    const minHours = num(
      anchor(dayWindowSrc, /const DEFAULT_MIN_HOURS_PER_DAY = (\d+);/, "day-window.ts")[1],
    );

    const doc = read("site", "src", "content", "docs", "docs", "python", "derivation-science.mdx");
    const claim = anchor(
      doc,
      /Day windowing \((\d{2}):00–(\d{2}):00 local, discard days with\s+fewer than (\w+) samples/,
      "python/derivation-science.mdx day-windowing sentence",
    );
    expect(num(claim[1])).toBe(startHour);
    expect(num(claim[2])).toBe(endHour);
    expect(NUMBER_WORDS[claim[3]]).toBe(minHours);
  });
});

describe("doc parity: usable-lift sink rate", () => {
  // Authority: the `sinkRateMs = <n>` parameter default and the `* 2.02`
  // max-updraft factor in packages/windgram/src/derive/usable-lift.ts.
  const usableLiftSrc = read("packages", "windgram", "src", "derive", "usable-lift.ts");
  const sinkDefault = num(
    anchor(usableLiftSrc, /sinkRateMs = ([\d.]+)\)/, "usable-lift.ts parameter default")[1],
  );
  const updraftFactor = num(
    anchor(
      usableLiftSrc,
      /thermalVelocityMs \* ([\d.]+) < sinkRateMs/,
      "usable-lift.ts max-updraft factor",
    )[1],
  );

  it("overview.mdx states the pipeline's stored sink rate", () => {
    const doc = read("site", "src", "content", "docs", "docs", "overview.mdx");
    const stated = num(
      anchor(doc, /stored ([\d.]+) m\/s value remains authoritative/, "overview.mdx")[1],
    );
    expect(stated).toBe(sinkDefault);
  });

  it("derivation-science.mdx states the published sink-rate case and algorithm numbers", () => {
    const doc = read("site", "src", "content", "docs", "docs", "python", "derivation-science.mdx");
    const publishedCase = num(
      anchor(
        doc,
        /published value is\s+the ([\d.]+) m\/s case/,
        "python/derivation-science.mdx package-parity sentence",
      )[1],
    );
    expect(publishedCase).toBe(sinkDefault);

    const shortCircuit = anchor(
      doc,
      /`([\d.]+) × w\* < ([\d.]+) m\/s`/,
      "python/derivation-science.mdx step 1 short-circuit",
    );
    expect(num(shortCircuit[1])).toBe(updraftFactor);
    expect(num(shortCircuit[2])).toBe(sinkDefault);

    const crossing = num(
      anchor(
        doc,
        /first height where the core falls to ([\d.]+) m\/s/,
        "python/derivation-science.mdx step 3 crossing",
      )[1],
    );
    expect(crossing).toBe(sinkDefault);
  });
});

describe("doc parity: CAPE strip classes", () => {
  it("reading-a-windgram.mdx states DEFAULT_CAPE_CLASSES", () => {
    const doc = read(
      "site",
      "src",
      "content",
      "docs",
      "docs",
      "learn",
      "reading-a-windgram.mdx",
    );
    const classes = anchor(
      doc,
      /\*\*calm\*\* below ([\d,]+) J\/kg, \*\*watch\*\* from ([\d,]+) J\/kg, \*\*risk\*\*\s+from ([\d,]+) J\/kg, or \*\*severe\*\* from ([\d,]+) J\/kg/,
      "learn/reading-a-windgram.mdx CAPE class sentence",
    );
    expect(num(classes[1])).toBe(DEFAULT_CAPE_CLASSES.watchJkg);
    expect(num(classes[2])).toBe(DEFAULT_CAPE_CLASSES.watchJkg);
    expect(num(classes[3])).toBe(DEFAULT_CAPE_CLASSES.riskJkg);
    expect(num(classes[4])).toBe(DEFAULT_CAPE_CLASSES.severeJkg);

    const capped = num(
      anchor(
        doc,
        /publishes CIN of (−[\d,]+) J\/kg or\s+stronger/,
        "learn/reading-a-windgram.mdx capped-cell sentence",
      )[1],
    );
    expect(capped).toBe(DEFAULT_CAPE_CLASSES.cappedCinJkg);
  });
});

describe("doc parity: physical constants", () => {
  it("derivation-science.mdx's constants table states the dry adiabatic lapse", () => {
    const doc = read("site", "src", "content", "docs", "docs", "python", "derivation-science.mdx");
    const stated = num(
      anchor(
        doc,
        /\| ([\d.]+) °C\/m \| dry adiabatic lapse \|/,
        "python/derivation-science.mdx constants table",
      )[1],
    );
    expect(stated).toBe(DRY_ADIABATIC_LAPSE_C_PER_M);
  });
});
