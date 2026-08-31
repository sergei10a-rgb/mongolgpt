import { defineConfig, devices } from "@playwright/test"

const adminURL = process.env.PLAYWRIGHT_DEPLOYED_ADMIN_URL
if (!adminURL) throw new Error("PLAYWRIGHT_DEPLOYED_ADMIN_URL is required")
if (new URL(adminURL).protocol !== "https:") throw new Error("PLAYWRIGHT_DEPLOYED_ADMIN_URL must use HTTPS")

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH

export default defineConfig({
  testDir: "./e2e/deployed",
  testMatch: "admin-access-smoke.spec.ts",
  outputDir: "./e2e/test-results-admin-deployed",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [["html", { outputFolder: "e2e/playwright-report-admin-deployed", open: "never" }], ["line"]],
  use: {
    baseURL: adminURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium-admin-desktop",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: executablePath ? { executablePath } : undefined,
      },
    },
    {
      name: "chromium-admin-mobile",
      use: {
        ...devices["Pixel 5"],
        launchOptions: executablePath ? { executablePath } : undefined,
      },
    },
  ],
})
