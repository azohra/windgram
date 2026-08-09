import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { canonicalRoutes, distDirectory, filesBelow } from "./helpers";

function liveDataResource(rawUrl: string): string | null {
  const pathname = new URL(rawUrl).pathname.replace(/\/{2,}/g, "/");
  const rules: Array<[string, RegExp]> = [
    ["site catalogue", /(?:^|\/)sites\.json$/],
    ["model catalogue", /(?:^|\/)data\/models\.json$/],
    ["current-run index", /(?:^|\/)data\/runs\.json$/],
    ["current manifest", /(?:^|\/)data\/[^/]+\/manifest\.json$/],
    ["current profile", /(?:^|\/)data\/[^/]+\/sites\/[^/]+\.json$/],
    ["history archive", /(?:^|\/)data\/[^/]+\/history(?:\/|$)/],
  ];
  return rules.find(([, pattern]) => pattern.test(pathname))?.[0] ?? null;
}

test("normal browsing never requests forecast publication data", async ({ browser, baseURL }) => {
  test.setTimeout(120_000);
  const origin = new URL(baseURL!).origin;
  const context = await browser.newContext({ baseURL, serviceWorkers: "block" });
  const externalRequests: string[] = [];
  const liveDataRequests: string[] = [];

  await context.route("**/*", async (route) => {
    const requestUrl = route.request().url();
    const url = new URL(requestUrl);
    const liveResource = liveDataResource(requestUrl);
    if (liveResource) {
      liveDataRequests.push(`${liveResource}: ${requestUrl}`);
      await route.abort("blockedbyclient");
      return;
    }

    if (url.protocol === "http:" || url.protocol === "https:") {
      if (url.origin !== origin) {
        externalRequests.push(requestUrl);
        await route.abort("blockedbyclient");
        return;
      }
    }
    await route.continue();
  });

  const page = await context.newPage();
  for (const route of canonicalRoutes) {
    await page.goto(route, { waitUntil: "networkidle" });
  }

  expect(liveDataRequests, "normal routes requested current forecast publication data").toEqual([]);
  expect(externalRequests, "normal routes attempted external network access").toEqual([]);
  await context.close();
});

test("normal routes contain no live-result picker or freshness UI", async ({ page }) => {
  test.setTimeout(120_000);
  const retiredSelectors = [
    ".wg-app",
    "#site-select",
    "#model-select",
    "#freshness",
    ".freshness",
    "[data-freshness]",
    "[data-current-run]",
    "[data-reference-time]",
    "[data-generated-at]",
    ".current-run",
    ".current-model",
    ".run-freshness",
    "#day-tabs",
    "#chart-mount",
    "#overlay-section",
    "[data-default-compare]",
  ].join(",");

  for (const route of canonicalRoutes) {
    await page.goto(route, { waitUntil: "networkidle" });
    await expect(page.locator(retiredSelectors), `${route} contains retired live-browser UI`).toHaveCount(0);
    await expect(
      page.getByRole("combobox", { name: /^(?:launch|site|model|forecast model|current model)$/i }),
      `${route} contains a launch or current-model result picker`,
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /^(?:choose|change|select) (?:a )?(?:launch|site|model)$/i }),
      `${route} contains a launch or current-model picker button`,
    ).toHaveCount(0);

    const labelledPickerCount = await page.locator("label").evaluateAll((labels) =>
      labels.filter(
        (label) =>
          /^(?:launch|site|model)$/i.test((label.textContent ?? "").trim()) &&
          Boolean(label.querySelector("select, [role='combobox'], [role='listbox']")),
      ).length,
    );
    expect(labelledPickerCount, `${route} contains a labelled live-result picker`).toBe(0);
  }
});

test("built assets contain no retired live-browser entry point", () => {
  const assetDirectory = path.join(distDirectory, "_astro");
  const assets = filesBelow(assetDirectory).filter((file) => /\.(?:css|js|mjs)$/.test(file));
  const retiredSignatures = [
    "InteractiveChart",
    "fetchSitesCatalog",
    "windgram:lastSite",
    "windgram:lastModel",
    "site-select",
    "model-select",
    "wg-app",
    "data-default-compare",
  ];

  const matches = assets.flatMap((file) => {
    const source = readFileSync(file, "utf8");
    return retiredSignatures
      .filter((signature) => source.includes(signature))
      .map((signature) => `${path.relative(distDirectory, file)}: ${signature}`);
  });

  expect(matches, "a built asset still contains a retired live-browser signature").toEqual([]);
});
