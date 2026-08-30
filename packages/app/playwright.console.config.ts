import { defineConfig, devices } from "@playwright/test"

const port = Number(process.env.PLAYWRIGHT_CONSOLE_PORT ?? 4174)
const baseURL = `http://127.0.0.1:${port}`
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH

export default defineConfig({
  testDir: "./e2e/console",
  outputDir: "./e2e/test-results-console",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [["html", { outputFolder: "e2e/playwright-report-console", open: "never" }], ["line"]],
  webServer: {
    command: `bun run --cwd ../console/app build && cd ../console/app && bunx wrangler --cwd .output dev --ip 127.0.0.1 --port ${port}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium-console-production",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: executablePath ? { executablePath } : undefined,
      },
    },
  ],
})
