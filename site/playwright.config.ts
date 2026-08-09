import { defineConfig } from "@playwright/test";

const port = 4329;

export default defineConfig({
  testDir: "./test",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  timeout: 30_000,
  workers: process.env.CI ? 2 : undefined,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    browserName: "chromium",
    colorScheme: "light",
    serviceWorkers: "block",
    trace: "retain-on-failure",
  },
  webServer: {
    // Astro backgrounds preview automatically in detected agent environments.
    // Playwright must own a foreground process so teardown is deterministic.
    command: `ASTRO_PREVIEW_BACKGROUND=0 pnpm preview --host 127.0.0.1 --port ${port}`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
  },
});
