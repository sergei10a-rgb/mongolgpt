import { expect, test } from "bun:test"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../../", import.meta.url))
const hosted = [...new Bun.Glob("smoke/hosted-*.spec.ts").scanSync({ cwd: join(root, "e2e"), onlyFiles: true })]
  .map((file) => file.replaceAll("\\", "/"))
  .sort()

for (const config of ["playwright.config.ts", "playwright.hosted.config.ts"]) {
  test(`${config} discovers hosted tests only in their dedicated environment`, () => {
    // List actual Playwright discovery without starting a browser, Vite or a backend.
    const result = Bun.spawnSync(
      [
        process.execPath,
        fileURLToPath(import.meta.resolve("@playwright/test/cli")),
        "test",
        "--config",
        config,
        "--list",
        "--reporter=json",
      ],
      { cwd: root, env: { ...process.env, MONGOLGPT_PERFORMANCE: undefined } },
    )
    expect({ exitCode: result.exitCode, failure: result.exitCode === 0 ? "" : result.stderr.toString() }).toEqual({
      exitCode: 0,
      failure: "",
    })
    const report: { suites: Array<{ file: string }> } = JSON.parse(result.stdout.toString())
    const files = report.suites.map((suite) => suite.file.replaceAll("\\", "/")).sort()
    expect(hosted.length).toBeGreaterThan(0)
    if (config === "playwright.hosted.config.ts") {
      expect(files).toEqual(hosted)
      return
    }
    expect(files.length).toBeGreaterThan(0)
    expect(files.filter((file) => hosted.includes(file))).toEqual([])
  }, 30_000)
}
