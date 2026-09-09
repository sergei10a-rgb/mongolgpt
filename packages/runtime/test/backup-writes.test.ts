import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { isAbsolute, join, relative } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"

for (const scenario of [
  {
    script: "backup-writes",
    name: "registered backup writes and erasure fences survive delayed and lost acknowledgements on real D1/R2",
    receipt: "BACKUP_WRITES_RESULT ",
    minimum: 55,
  },
  {
    script: "account-cleanup",
    name: "runtime account cleanup resumes across failures without skipping sandboxes, R2 or D1 content",
    receipt: "ACCOUNT_CLEANUP_RESULT ",
    minimum: 40,
  },
])
  test(
    scenario.name,
    async () => {
      const root = await mkdtemp(join(tmpdir(), "mongolgpt-backup-writes-bundle-"))
      try {
        const build = await Bun.build({
          entrypoints: [fileURLToPath(new URL("./fixtures/backup-writes-native.ts", import.meta.url))],
          outdir: root,
          naming: "native.mjs",
          target: "node",
        })
        if (!build.success) throw new Error("backup-write fixture build failed")
        const node = Bun.which("node")
        if (!node) throw new Error("Node is required for real D1/R2 tests")
        const child = spawn(
          node,
          ["--experimental-strip-types", `test/${scenario.script}.integration.ts`, join(root, "native.mjs")],
          {
            cwd: fileURLToPath(new URL("..", import.meta.url)),
            windowsHide: true,
            env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
            stdio: ["ignore", "pipe", "pipe"],
          },
        )
        const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
          let stdout = ""
          let stderr = ""
          let timedOut = false
          const timer = setTimeout(() => {
            timedOut = true
            child.kill("SIGTERM")
          }, 120_000)
          child.stdout.on("data", (chunk) => (stdout = (stdout + chunk).slice(-16000)))
          child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-16000)))
          child.once("error", (error) => {
            clearTimeout(timer)
            reject(error)
          })
          child.once("close", (code) => {
            clearTimeout(timer)
            if (timedOut)
              return reject(new Error(`backup-write test timed out\n${stdout.slice(-2000)}\n${stderr.slice(-2000)}`))
            resolve({ code, stdout, stderr })
          })
        })
        if (result.code !== 0)
          throw new Error(
            `backup-write test failed (${result.code})\n${result.stdout.slice(-3000)}\n${result.stderr.slice(-3000)}`,
          )
        const line = result.stdout.split(/\r?\n/).find((value) => value.startsWith(scenario.receipt))
        expect(line).toBeDefined()
        const receipt = JSON.parse(line!.slice(scenario.receipt.length))
        expect(receipt.ok).toBe(true)
        expect(receipt.assertions).toBeGreaterThanOrEqual(scenario.minimum)
        expect(receipt.realD1).toBe(true)
        expect(receipt.realR2).toBe(true)
        console.log(`${scenario.script}: ${receipt.assertions} real D1/R2 assertions passed`)
      } finally {
        const inside = relative(tmpdir(), root)
        if (!inside || inside.startsWith("..") || isAbsolute(inside))
          throw new Error("backup-write bundle escaped temp root")
        await rm(root, { recursive: true, force: true })
      }
    },
    130_000,
  )
