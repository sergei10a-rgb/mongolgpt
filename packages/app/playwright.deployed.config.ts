import { defineConfig, devices } from "@playwright/test"

const baseURL = process.env.PLAYWRIGHT_DEPLOYED_BASE_URL
if (!baseURL) throw new Error("PLAYWRIGHT_DEPLOYED_BASE_URL is required")
const publicURL = process.env.PLAYWRIGHT_DEPLOYED_PUBLIC_URL
if (!publicURL) throw new Error("PLAYWRIGHT_DEPLOYED_PUBLIC_URL is required")
if (new URL(publicURL).protocol !== "https:") throw new Error("PLAYWRIGHT_DEPLOYED_PUBLIC_URL must use HTTPS")
const runtimeURL = process.env.PLAYWRIGHT_DEPLOYED_RUNTIME_URL
if (!runtimeURL) throw new Error("PLAYWRIGHT_DEPLOYED_RUNTIME_URL is required")
if (new URL(runtimeURL).protocol !== "https:") throw new Error("PLAYWRIGHT_DEPLOYED_RUNTIME_URL must use HTTPS")
if (new URL(runtimeURL).origin === new URL(baseURL).origin) {
  throw new Error("PLAYWRIGHT_DEPLOYED_RUNTIME_URL must not use the static app origin")
}

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
      name: "chromium-deployed-desktop",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: executablePath ? { executablePath } : undefined,
      },
    },
    {
      name: "chromium-deployed-mobile",
      testIgnore: "**/authenticated-browser-smoke.spec.ts",
      use: {
        ...devices["Pixel 5"],
        launchOptions: executablePath ? { executablePath } : undefined,
      },
    },
  ],
})
