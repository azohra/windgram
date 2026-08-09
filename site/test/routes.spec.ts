import { expect, test } from "@playwright/test";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const researchDirectory = fileURLToPath(new URL("../src/content/research/", import.meta.url));

function filesBelow(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(absolute) : [absolute];
  });
}

function researchRoutes(): string[] {
  return filesBelow(researchDirectory)
    .filter((file) => file.endsWith(".mdx"))
    .map((file) => path.relative(researchDirectory, file).replace(/\.mdx$/, "").replace(/\/index$/, ""))
    .sort()
    .map((slug) => `/research/${slug}/`);
}

const publicRoutes = ["/", "/docs/", "/research/", ...researchRoutes(), "/about/"];

test.describe("public no-live-data boundary routes", () => {
  for (const route of publicRoutes) {
    test(`${route} renders from the static build`, async ({ page, baseURL }) => {
      const browserErrors: string[] = [];
      const externalRequests: string[] = [];
      const previewOrigin = new URL(baseURL!).origin;
      page.on("pageerror", (error) => browserErrors.push(error.message));
      await page.route("**/*", async (intercepted) => {
        const url = new URL(intercepted.request().url());
        if (
          (url.protocol === "http:" || url.protocol === "https:") &&
          url.origin !== previewOrigin
        ) {
          externalRequests.push(url.href);
          await intercepted.abort("blockedbyclient");
          return;
        }
        await intercepted.continue();
      });

      const response = await page.goto(route, { waitUntil: "networkidle" });

      expect(response, `${route} did not return a document response`).not.toBeNull();
      expect(response!.ok(), `${route} returned ${response!.status()}`).toBe(true);
      await expect(page.locator("main")).toBeVisible();
      expect(browserErrors).toEqual([]);
      expect(externalRequests, `${route} attempted external network access`).toEqual([]);
    });
  }
});
