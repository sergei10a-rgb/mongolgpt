import config from "../../playwright.config"

const port = Number(process.env.PLAYWRIGHT_PORT ?? 3000)
const serverPort = process.env.PLAYWRIGHT_SERVER_PORT ?? String(port + 1)
if (serverPort === String(port)) throw new Error("Performance UI and mock API must use different ports")
process.env.PLAYWRIGHT_SERVER_PORT = serverPort
process.env.MONGOLGPT_PERFORMANCE_RUN_ID ??= `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`

export default {
  ...config,
  testDir: ".",
  testIgnore: "unit/**",
  outputDir: "../test-results/performance",
  fullyParallel: false,
  workers: 1,
  reporter: [["html", { outputFolder: "../playwright-report/performance", open: "never" }], ["line"]],
  webServer: {
    ...config.webServer,
    command: `bun run build && bun run serve -- --host 0.0.0.0 --port ${port} --strictPort`,
    reuseExistingServer: false,
    env: {
      ...config.webServer.env,
      VITE_MONGOLGPT_SERVER_PORT: serverPort,
    },
  },
}
