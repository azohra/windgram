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

const layouts = [
  { name: "homepage", route: "/", target: "main" },
  { name: "docs-portal", route: "/docs/", target: "main" },
  { name: "research-index", route: "/research/", target: "main" },
  { name: "research-article", route: "/research/forecast-data-validation-failures/", target: "main" },
] as const;

const viewports = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile-390", width: 390, height: 844 },
] as const;

const reducedMotionFigures = [
  { name: "ensemble-spread", route: "/docs/data/ensemble-values/", target: "#ensemble-spread-lab" },
  { name: "model-disagreement", route: "/docs/models/choosing/", target: "#model-disagreement-lab" },
  { name: "parcel", route: "/docs/python/derivation-science/", target: "#parcel-lab" },
  { name: "usable-lift", route: "/docs/python/derivation-science/", target: "#usable-lift-lab" },
  { name: "wind-shear", route: "/docs/learn/reading-a-windgram/", target: "#wind-shear-lab" },
  { name: "homepage-layers", route: "/", target: "#home-convective-cycle" },
] as const;

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

const canonicalRoutes = filesBelow(distDirectory)
  .filter((file) => file.endsWith(".html") && path.basename(file) !== "404.html")
  .map(routeForBuiltPage)
  .filter((route) => !redirectRoutes.has(route))
  .sort();

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

async function settleVisualFrame(page: Page) {
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-delay: 0s !important;
        animation-duration: 0s !important;
        caret-color: transparent !important;
        scroll-behavior: auto !important;
        transition-delay: 0s !important;
        transition-duration: 0s !important;
      }
    `,
  });
  await page.evaluate(async () => {
    await document.fonts.ready;
    window.scrollTo(0, 0);
  });
}

async function stableScreenshot(target: Locator, name: string) {
  const first = await target.screenshot({ animations: "disabled", caret: "hide", scale: "css" });
  await target.page().waitForTimeout(100);
  const second = await target.screenshot({ animations: "disabled", caret: "hide", scale: "css" });
  expect(second.equals(first), `${name} did not settle to a stable reduced-motion frame`).toBe(true);
  await expect(target).toHaveScreenshot(name, {
    animations: "disabled",
    caret: "hide",
    maxDiffPixelRatio: 0.025,
    scale: "css",
    threshold: 0.25,
  });
}

test.describe("desktop and 390 px visual regression fixtures", () => {
  for (const viewport of viewports) {
    for (const layout of layouts) {
      test(`${layout.name} at ${viewport.name}`, async ({ page, baseURL }) => {
        test.setTimeout(60_000);
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        const externalRequests = await guardStaticBrowsing(page, baseURL!);
        await page.goto(layout.route, { waitUntil: "networkidle" });
        await settleVisualFrame(page);
        await stableScreenshot(page.locator(layout.target), `${layout.name}-${viewport.name}.png`);
        expect(externalRequests, `${layout.route} attempted external network access`).toEqual([]);
      });
    }
  }
});

test("every canonical page contains horizontal overflow at its labelled figure boundary", async ({ page, baseURL }) => {
  test.setTimeout(150_000);
  const externalRequests = await guardStaticBrowsing(page, baseURL!);

  for (const viewport of viewports) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    for (const route of canonicalRoutes) {
      await test.step(`${viewport.name} ${route}`, async () => {
        await page.goto(route, { waitUntil: "networkidle" });
        const overflow = await page.evaluate(() => ({
          body: document.body.scrollWidth - document.body.clientWidth,
          document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        }));
        expect(overflow.document, `${route} overflows the ${viewport.width}px page`).toBeLessThanOrEqual(1);
        expect(overflow.body, `${route} body overflows the ${viewport.width}px page`).toBeLessThanOrEqual(1);

        const unlabelledIntentionalRegions = await page.locator("figure *").evaluateAll((regions) => regions.flatMap((region) => {
          const element = region as HTMLElement;
          const overflowX = getComputedStyle(element).overflowX;
          if (element.matches("pre, code")) return [];
          if (!["auto", "scroll"].includes(overflowX) || element.scrollWidth <= element.clientWidth + 1) return [];
          const labelled = element.getAttribute("role") === "region" &&
            element.tabIndex === 0 && Boolean(
              element.getAttribute("aria-label")?.trim() || element.getAttribute("aria-labelledby")?.trim(),
            );
          const contained = element.getBoundingClientRect().right <= document.documentElement.clientWidth + 1;
          if (labelled && contained) return [];
          const name = element.getAttribute("aria-label") || element.getAttribute("aria-labelledby") || "unlabelled";
          const identity = [element.tagName.toLowerCase(), element.id && `#${element.id}`, ...element.classList]
            .filter(Boolean)
            .join(".");
          return [`${identity} (${name}; ${element.clientWidth}px viewport, ${element.scrollWidth}px content)`];
        }));
        expect(
          unlabelledIntentionalRegions,
          `${route} has overflow outside a labelled, keyboard-scrollable figure boundary`,
        ).toEqual([]);
      });
    }
  }

  expect(externalRequests, "responsive route audit attempted external network access").toEqual([]);
});

test.describe("reduced-motion flagship figure frames", () => {
  for (const figure of reducedMotionFigures) {
    test(`${figure.name} has a stable explanatory first frame`, async ({ page, baseURL }) => {
      await page.setViewportSize({ width: 1100, height: 900 });
      const externalRequests = await guardStaticBrowsing(page, baseURL!);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(figure.route, { waitUntil: "networkidle" });
      await settleVisualFrame(page);
      await page.addStyleTag({
        content: `
          .page > .header,
          .page > .header *,
          .page > .sidebar,
          .page > .sidebar *,
          .right-sidebar-container,
          .right-sidebar-container * {
            position: static !important;
          }
        `,
      });
      const target = page.locator(figure.target);
      await expect(target).toBeVisible();
      await stableScreenshot(target, `reduced-motion-${figure.name}.png`);

      const movingParts = await target.locator("[data-motion-part]").evaluateAll((parts) =>
        parts.flatMap((part) => {
          const style = getComputedStyle(part);
          const transition = style.transitionDuration.split(",").some((duration) => parseFloat(duration) > 0);
          const animation = style.animationName.split(",").some((name) => name !== "none");
          return transition || animation ? [(part as HTMLElement).dataset.motionPart ?? part.tagName] : [];
        }),
      );
      expect(movingParts, `${figure.name} keeps motion enabled when reduced motion is requested`).toEqual([]);
      expect(externalRequests, `${figure.route} attempted external network access`).toEqual([]);
    });
  }
});
