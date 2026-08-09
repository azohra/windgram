import { expect, test, type Locator, type Page } from "@playwright/test";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const siteDirectory = fileURLToPath(new URL("../", import.meta.url));
const distDirectory = path.join(siteDirectory, "dist");

const redirectRoutes = new Set([
  "/chart/",
  "/reference/forecast-model-feeds/",
  "/research/choosing-forecast-models/",
  "/research/model-capabilities/",
  "/research/reading-a-windgram/",
  "/research/why-this-project-exists/",
]);

function filesBelow(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(absolute) : [absolute];
  });
}

function routeForBuiltPage(file: string): string {
  const relative = path.relative(distDirectory, file).replaceAll(path.sep, "/");
  if (relative === "index.html") return "/";
  if (relative.endsWith("/index.html")) return `/${relative.slice(0, -"index.html".length)}`;
  return `/${relative.replace(/\.html$/, "")}`;
}

const publicRoutes = filesBelow(distDirectory)
  .filter((file) => file.endsWith(".html") && path.basename(file) !== "404.html")
  .map(routeForBuiltPage)
  .sort();
const canonicalRoutes = publicRoutes.filter((route) => !redirectRoutes.has(route));

async function guardStaticBrowsing(page: Page, baseURL: string) {
  const origin = new URL(baseURL).origin;
  const externalRequests: string[] = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if ((url.protocol === "http:" || url.protocol === "https:") && url.origin !== origin) {
      externalRequests.push(url.href);
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  return externalRequests;
}

async function expectReadableCode(pre: Locator, minimumSamples: number) {
  const contrast = await pre.evaluate((element) => {
    function luminance(color: string): number {
      const channels = color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
      if (!channels || channels.length !== 3) throw new Error(`Cannot parse ${color}`);
      const linear = channels.map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
    }

    function ratio(foreground: string, background: string): number {
      const lighter = Math.max(luminance(foreground), luminance(background));
      const darker = Math.min(luminance(foreground), luminance(background));
      return (lighter + 0.05) / (darker + 0.05);
    }

    const background = getComputedStyle(element).backgroundColor;
    const samples = Array.from(element.querySelectorAll("code, code span"))
      .filter((sample) => sample.textContent?.trim())
      .map((sample) => ({
        color: getComputedStyle(sample).color,
        text: sample.textContent?.trim().slice(0, 30),
      }));
    return {
      background,
      samples: samples.map((sample) => ({
        ...sample,
        ratio: ratio(sample.color, background),
      })),
    };
  });

  expect(contrast.samples.length).toBeGreaterThanOrEqual(minimumSamples);
  for (const sample of contrast.samples) {
    expect(sample.ratio, `${sample.text} (${sample.color} on ${contrast.background})`).toBeGreaterThanOrEqual(4.5);
  }
}

test.describe("static route and accessibility contract", () => {
  test("every expected built route succeeds without external network access", async ({ page, baseURL }) => {
    test.setTimeout(120_000);
    const browserErrors: string[] = [];
    let currentRoute = "";
    page.on("pageerror", (error) => browserErrors.push(`${currentRoute}: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(`${currentRoute}: console: ${message.text()}`);
    });
    const externalRequests = await guardStaticBrowsing(page, baseURL!);

    expect(publicRoutes.length, "the built route inventory is unexpectedly small").toBeGreaterThan(40);
    for (const route of publicRoutes) {
      await test.step(route, async () => {
        currentRoute = route;
        const response = await page.goto(route, { waitUntil: "networkidle" });
        expect(response, `${route} did not return a document response`).not.toBeNull();
        expect(response!.ok(), `${route} returned ${response!.status()}`).toBe(true);
      });
    }

    expect(browserErrors).toEqual([]);
    expect(externalRequests, "public routes attempted external network access").toEqual([]);
  });

  test("canonical pages expose named controls, headings, and landmarks", async ({ page, baseURL }) => {
    test.setTimeout(120_000);
    const externalRequests = await guardStaticBrowsing(page, baseURL!);

    for (const route of canonicalRoutes) {
      await test.step(route, async () => {
        await page.goto(route, { waitUntil: "networkidle" });

        await expect(page.getByRole("main"), `${route} must have one main landmark`).toHaveCount(1);
        await expect(page.getByRole("banner"), `${route} must have one banner landmark`).toHaveCount(1);
        if (route.startsWith("/docs/")) {
          await expect(page.locator("footer.docs-footer"), `${route} must expose its Starlight page footer`)
            .toHaveCount(1);
        } else {
          await expect(page.getByRole("contentinfo"), `${route} must have one contentinfo landmark`).toHaveCount(1);
        }
        await expect(page.getByRole("heading", { level: 1 }), `${route} must have one h1`).toHaveCount(1);

        const headings = page.getByRole("heading");
        await expect(
          page.getByRole("heading", { name: /\S/ }),
          `${route} has an unnamed heading`,
        ).toHaveCount(await headings.count());

        const navigations = page.getByRole("navigation");
        await expect(
          page.getByRole("navigation", { name: /\S/ }),
          `${route} has an unnamed navigation landmark`,
        ).toHaveCount(await navigations.count());

        for (const role of ["button", "link", "textbox", "combobox", "slider"] as const) {
          const controls = page.getByRole(role);
          await expect(
            page.getByRole(role, { name: /\S/ }),
            `${route} has an unnamed ${role}`,
          ).toHaveCount(await controls.count());
        }

        const framedFigures = page.locator("figure[data-figure]");
        for (const figure of await framedFigures.all()) {
          await expect(figure, `${route} has a figure without an accessible name`)
            .toHaveAccessibleName(/\S/);
        }
      });
    }

    expect(externalRequests, "canonical routes attempted external network access").toEqual([]);
  });

  test("SVG IDs are unique within every canonical document", async ({ page, baseURL }) => {
    test.setTimeout(120_000);
    const externalRequests = await guardStaticBrowsing(page, baseURL!);

    for (const route of canonicalRoutes) {
      await test.step(route, async () => {
        await page.goto(route, { waitUntil: "networkidle" });
        const duplicateIds = await page.locator("svg [id]").evaluateAll((elements) => {
          const counts = new Map<string, number>();
          for (const element of elements) {
            const id = element.id;
            counts.set(id, (counts.get(id) ?? 0) + 1);
          }
          return [...counts].filter(([, count]) => count > 1).map(([id, count]) => `${id} (${count})`);
        });
        expect(duplicateIds, `${route} contains duplicate IDs inside SVG content`).toEqual([]);
      });
    }

    expect(externalRequests, "canonical routes attempted external network access").toEqual([]);
  });

  test("teaching figures carry descriptions without provenance badges", async ({ page, baseURL }) => {
    test.setTimeout(120_000);
    const externalRequests = await guardStaticBrowsing(page, baseURL!);
    let scenarioFigureCount = 0;

    for (const route of canonicalRoutes) {
      await page.goto(route, { waitUntil: "networkidle" });
      const scenarioFigureIds = await page.locator("figure[data-figure]").evaluateAll((figures) =>
        figures
          .filter((figure) => figure.querySelector([
            "[data-synthetic-windgram]",
            "[data-ensemble-lab]",
            "[data-timing-lab]",
            "[data-parcel-lab]",
            "[data-usable-lab]",
            "[data-shear-lab]",
          ].join(",")))
          .map((figure) => figure.id),
      );

      for (const id of scenarioFigureIds) {
        scenarioFigureCount += 1;
        const figure = page.locator(`#${id}`);
        await expect(figure.locator(".wg-visually-hidden").first(), `${route}#${id} needs a description`)
          .toContainText(/\S/);
        await expect(figure.locator(".wg-scenario-badge"), `${route}#${id} repeats input provenance`).toHaveCount(0);
      }
    }

    expect(scenarioFigureCount, "the scenario-figure inventory is unexpectedly small").toBeGreaterThanOrEqual(10);
    expect(externalRequests, "scenario figures attempted external network access").toEqual([]);
  });

  test("research thumbnails depict each article's declared evidence relationship", async ({ page, baseURL }) => {
    const externalRequests = await guardStaticBrowsing(page, baseURL!);
    await page.goto("/research/", { waitUntil: "networkidle" });

    const thumbnails = page.locator("[data-thumbnail-visual]");
    await expect(thumbnails).toHaveCount(7);
    const visuals = await thumbnails.evaluateAll((elements) =>
      elements.map((element) => (element as HTMLElement).dataset.thumbnailVisual),
    );
    expect(new Set(visuals).size, "research thumbnails must not reuse one generic composition").toBe(7);
    for (const thumbnail of await thumbnails.all()) await expect(thumbnail).toHaveAccessibleName(/\S/);

    expect(externalRequests, "research thumbnails attempted external network access").toEqual([]);
  });
});

test.describe("fixed light colour system", () => {
  test.use({ colorScheme: "dark" });

  test("documentation code keeps readable syntax colours under a dark OS preference", async ({ page }) => {
    await page.goto("/docs/typescript/scene/", { waitUntil: "networkidle" });

    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expectReadableCode(page.locator(".expressive-code pre").first(), 6);
  });

  test("derivation reference code keeps readable syntax colours under a dark OS preference", async ({ page }) => {
    await page.goto("/docs/python/derivation-science/", { waitUntil: "networkidle" });

    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    const blocks = page.locator(".expressive-code pre");
    await expect(blocks).toHaveCount(3);
    for (const block of await blocks.all()) await expectReadableCode(block, 2);
  });
});

test("homepage windgram leads with atmospheric content", async ({ page }) => {
  await page.goto("/", { waitUntil: "networkidle" });

  const section = page.locator(".home-windgram-section");
  await expect(section).toBeVisible();
  await expect(section).not.toContainText(/synthetic|not a forecast|current forecast/i);
  await expect(section.locator(".wg-scenario-badge")).toHaveCount(0);
  await expect(section.locator(".wg-figure__lesson")).toHaveCount(0);
});
