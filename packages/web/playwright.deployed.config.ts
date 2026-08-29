import { defineConfig, devices } from "@playwright/test"

const baseURL = process.env.PLAYWRIGHT_DEPLOYED_DOCS_URL
if (!baseURL) throw new Error("PLAYWRIGHT_DEPLOYED_DOCS_URL is required")

const docsURL = new URL(baseURL)
const loopback = docsURL.hostname === "127.0.0.1" || docsURL.hostname === "localhost"
if (docsURL.protocol !== "https:" && !(loopback && process.env.CI !== "true")) {
  throw new Error("PLAYWRIGHT_DEPLOYED_DOCS_URL must use HTTPS outside a local smoke test")
}
if (!docsURL.pathname.endsWith("/docs/")) throw new Error("PLAYWRIGHT_DEPLOYED_DOCS_URL must end with /docs/")

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/deployed/**/*.spec.ts",
  outputDir: "./e2e/test-results-deployed",
  timeout: 60_000,
  expect: {
    timeout: 12_000,
  },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [["html", { outputFolder: "e2e/playwright-report-deployed", open: "never" }], ["line"]],
  use: {
    baseURL: docsURL.toString(),
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium-docs-desktop",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: executablePath ? { executablePath } : undefined,
      },
    },
    {
      name: "chromium-docs-mobile",
      use: {
        ...devices["Pixel 7"],
        launchOptions: executablePath ? { executablePath } : undefined,
      },
    },
  ],
})
