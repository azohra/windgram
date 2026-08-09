import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { filesBelow, guardStaticBrowsing } from "./helpers";

/* Unlike the dist-derived inventories the other suites audit, these routes
   are derived from the content SOURCE: every research entry must have made
   it into the build, so an article silently dropped from the output fails
   here instead of simply never being visited. */

const researchDirectory = fileURLToPath(new URL("../src/content/research/", import.meta.url));

function researchRoutes(): string[] {
  return filesBelow(researchDirectory)
    .filter((file) => file.endsWith(".mdx"))
    .map((file) => path.relative(researchDirectory, file).replace(/\.mdx$/, "").replace(/\/index$/, ""))
    .sort()
    .map((slug) => `/research/${slug}/`);
}

const expectedRoutes = ["/", "/docs/", "/research/", ...researchRoutes(), "/about/"];

test.describe("every content-source route exists in the static build", () => {
  for (const route of expectedRoutes) {
    test(`${route} renders from the static build`, async ({ page, baseURL }) => {
      const browserErrors: string[] = [];
      page.on("pageerror", (error) => browserErrors.push(error.message));
      const externalRequests = await guardStaticBrowsing(page, baseURL!);

      const response = await page.goto(route, { waitUntil: "networkidle" });

      expect(response, `${route} did not return a document response`).not.toBeNull();
      expect(response!.ok(), `${route} returned ${response!.status()}`).toBe(true);
      await expect(page.locator("main")).toBeVisible();
      expect(browserErrors).toEqual([]);
      expect(externalRequests, `${route} attempted external network access`).toEqual([]);
    });
  }
});
