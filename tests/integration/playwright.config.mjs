import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  // A single boundary test intentionally keeps one disposable Foundry world and
  // browser session alive across document, canvas, combat, and socket phases.
  // Slow CI runners need headroom, while per-phase logging identifies stalls.
  timeout: 1_200_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list", { printSteps: true }], ["html", { outputFolder: "test-results/report", open: "never" }]],
  outputDir: "test-results/artifacts",
  use: {
    baseURL: process.env.FOUNDRY_BASE_URL ?? "http://127.0.0.1:30000",
    browserName: "chromium",
    headless: true,
    viewport: { width: 1920, height: 1080 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
});
