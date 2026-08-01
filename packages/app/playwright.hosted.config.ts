import { defineConfig, devices } from "@playwright/test"

const port = Number(process.env.PLAYWRIGHT_HOSTED_PORT ?? 4173)
const baseURL = process.env.PLAYWRIGHT_HOSTED_BASE_URL ?? `http://127.0.0.1:${port}`
const runtimeUrl = process.env.PLAYWRIGHT_HOSTED_RUNTIME_URL ?? "https://runtime.e2e.mgpt.test:4443"
const publicUrl = process.env.PLAYWRIGHT_HOSTED_PUBLIC_URL ?? "https://dev.e2e.mgpt.test"
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
const managedServer = process.env.PLAYWRIGHT_HOSTED_MANAGED_SERVER === "true"

process.env.PLAYWRIGHT_SERVER_URL = runtimeUrl
process.env.PLAYWRIGHT_SERVER_PORT = new URL(runtimeUrl).port || (runtimeUrl.startsWith("https:") ? "443" : "80")

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/hosted-account-gate.spec.ts",
  outputDir: "./e2e/test-results-hosted",
  timeout: 60_000,
  expect: {
    timeout: 15_000,
  },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: [["html", { outputFolder: "e2e/playwright-report-hosted", open: "never" }], ["line"]],
  ...(managedServer
    ? {}
    : {
        webServer: {
          command: `bun ./node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${port}`,
          url: baseURL,
          reuseExistingServer: !process.env.CI,
          timeout: 120_000,
          env: {
            VITE_MONGOLGPT_SERVER_URL: runtimeUrl,
            VITE_MONGOLGPT_APP_URL: "https://app.dev.e2e.mgpt.test",
            VITE_MONGOLGPT_PUBLIC_URL: publicUrl,
            MONGOLGPT_CHANNEL: "dev",
          },
        },
      }),
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium-hosted",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: executablePath ? { executablePath } : undefined,
      },
    },
  ],
})
