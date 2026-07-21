import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "stories.spec.ts",
  timeout: 60_000,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 4 : 6,
  fullyParallel: true,
  reporter:
    process.env.ARGOS_TOKEN || process.env.CI
      ? [["list"], ["@argos-ci/playwright/reporter"]]
      : "list",
  use: {
    baseURL: "http://127.0.0.1:6006",
    contextOptions: { reducedMotion: "reduce" },
    // Same default frame Chromatic uses, so stories without their own
    // `chromatic: { viewports: [...] }` land on a comparable canvas.
    viewport: { width: 1200, height: 800 },
  },
  webServer: {
    command: "npx http-server ../storybook-static --port 6006 --silent",
    url: "http://127.0.0.1:6006/iframe.html",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
