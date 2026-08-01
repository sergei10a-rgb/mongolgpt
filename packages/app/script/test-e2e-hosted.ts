import { existsSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { chromium } from "@playwright/test"
import { createServer } from "vite"

const root = resolve(import.meta.dir, "..")
const port = Number(process.env.PLAYWRIGHT_HOSTED_PORT ?? 4173)
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PLAYWRIGHT_HOSTED_PORT must be a valid TCP port")
}

process.env.PLAYWRIGHT_HOSTED_PORT = String(port)
process.env.PLAYWRIGHT_HOSTED_MANAGED_SERVER = "true"
process.env.VITE_MONGOLGPT_SERVER_URL =
  process.env.PLAYWRIGHT_HOSTED_RUNTIME_URL ?? "https://runtime.e2e.mgpt.test:4443"
process.env.VITE_MONGOLGPT_APP_URL = "https://app.dev.e2e.mgpt.test"
process.env.VITE_MONGOLGPT_PUBLIC_URL = process.env.PLAYWRIGHT_HOSTED_PUBLIC_URL ?? "https://dev.e2e.mgpt.test"
process.env.MONGOLGPT_CHANNEL = "dev"
const executablePath = installedChromium()
if (!process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH && executablePath) {
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = executablePath
}

const server = await createServer({
  root,
  configFile: resolve(root, "vite.config.ts"),
  server: {
    host: "127.0.0.1",
    port,
    strictPort: true,
    watch: {
      ignored: ["**/e2e/playwright-report-hosted/**", "**/e2e/test-results-hosted/**"],
    },
  },
})

let exitCode = 1
try {
  await server.listen()
  await server.warmupRequest("/")
  const child = Bun.spawn(
    [process.execPath, "x", "playwright", "test", "--config", "playwright.hosted.config.ts", ...process.argv.slice(2)],
    {
      cwd: root,
      env: process.env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  )
  exitCode = await child.exited
} finally {
  await server.close()
}

process.exit(exitCode)

function installedChromium() {
  const bundled = chromium.executablePath()
  if (existsSync(bundled)) return bundled
  if (process.platform !== "win32") return undefined

  const localAppData = process.env.LOCALAPPDATA
  if (localAppData) {
    const browserRoot = join(localAppData, "ms-playwright")
    if (existsSync(browserRoot)) {
      const revisions = readdirSync(browserRoot)
        .filter((name) => /^chromium-\d+$/.test(name))
        .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
      for (const revision of revisions) {
        const executable = join(browserRoot, revision, "chrome-win64", "chrome.exe")
        if (existsSync(executable)) return executable
      }
    }
  }

  const candidates = [
    join(process.env.ProgramFiles ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
    join(
      process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
      "Microsoft",
      "Edge",
      "Application",
      "msedge.exe",
    ),
  ]
  return candidates.find(existsSync)
}
