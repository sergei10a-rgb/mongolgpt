import { defineConfig, devices } from "@playwright/test"

const baseURL = process.env.PLAYWRIGHT_DEPLOYED_BASE_URL
if (!baseURL) throw new Error("PLAYWRIGHT_DEPLOYED_BASE_URL is required")

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/deployed/**/*.spec.ts",
  outputDir: "./e2e/test-results-deployed",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [["html", { outputFolder: "e2e/playwright-report-deployed", open: "never" }], ["line"]],
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium-deployed",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: executablePath ? { executablePath } : undefined,
      },
    },
  ],
})
