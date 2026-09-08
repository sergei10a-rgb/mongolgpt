import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

const runtimeDirectory = fileURLToPath(new URL("../", import.meta.url))

describe("cloudflare canary worker", () => {
  test("runs isolated mocked canary cases in a private Bun subprocess", async () => {
    const child = Bun.spawn([process.execPath, "test", "./test/fixtures/cloudflare-canary.cases.ts"], {
      cwd: runtimeDirectory,
      stderr: "pipe",
      stdout: "pipe",
    })
    let didExit = false
    let timedOut = false
    const exited = child.exited.finally(() => {
      didExit = true
    })
    const deadline = setTimeout(() => {
      timedOut = true
      child.kill()
    }, 10_000)

    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        exited,
      ])

      expect(timedOut).toBe(false)
      expect(`${stdout}\n${stderr}`).toContain("pass")
      expect(exitCode).toBe(0)
    } finally {
      clearTimeout(deadline)
      if (!didExit) child.kill()
      await exited.catch(() => {})
    }
  }, 15_000)
})
