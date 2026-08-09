import type { Page } from "@playwright/test";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/* One home for the plumbing every suite shares: the built-output route
   inventory and the static-browsing guard. Suite-specific machinery (the
   live-data resource rules, visual settling) stays with its suite. */

export const siteDirectory = fileURLToPath(new URL("../", import.meta.url));
export const distDirectory = path.join(siteDirectory, "dist");

export function filesBelow(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(absolute) : [absolute];
  });
}

export function routeForBuiltPage(file: string): string {
  const relative = path.relative(distDirectory, file).replaceAll(path.sep, "/");
  if (relative === "index.html") return "/";
  if (relative.endsWith("/index.html")) return `/${relative.slice(0, -"index.html".length)}`;
  return `/${relative.replace(/\.html$/, "")}`;
}

/** Every page in the built output, 404 excluded — derived from dist so the
    suites audit exactly what ships. */
export const canonicalRoutes = filesBelow(distDirectory)
  .filter((file) => file.endsWith(".html") && path.basename(file) !== "404.html")
  .map(routeForBuiltPage)
  .sort();

/** Abort and record any request leaving the preview origin: the site must
    browse as a purely static artifact. Returns the (ideally empty) log. */
export async function guardStaticBrowsing(page: Page, baseURL: string): Promise<string[]> {
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
