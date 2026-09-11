import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

test("payment recovery leases and audit remain atomic on real D1", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mongolgpt-recovery-native-"))
  try {
    const build = await Bun.build({
      entrypoints: [fileURLToPath(new URL("./fixtures/payment-recovery-native.ts", import.meta.url))],
      outdir: directory,
      naming: "recovery.mjs",
      target: "node",
    })
    if (!build.success) throw new Error(`Recovery fixture build failed: ${build.logs.join("\n")}`)
    const node = Bun.which("node")
    if (!node) throw new Error("Node is required for the local D1 recovery test")
    const child = spawn(
      node,
      ["--experimental-strip-types", "test/payment-recovery-d1.integration.ts", join(directory, "recovery.mjs")],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        windowsHide: true,
        env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
    const output = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; text: string }>(
      (resolve, reject) => {
        let text = ""
        let timedOut = false
        const timer = setTimeout(() => {
          timedOut = true
          child.kill("SIGTERM")
        }, 120_000)
        for (const stream of [child.stdout, child.stderr])
          stream.on("data", (chunk) => {
            text = (text + chunk).slice(-16000)
          })
        child.once("error", (error) => {
          clearTimeout(timer)
          reject(error)
        })
        child.once("close", (code, signal) => {
          clearTimeout(timer)
          if (timedOut) return reject(new Error(`D1 recovery test timed out\n${text}`))
          resolve({ code, signal, text })
        })
      },
    )
    if (output.code !== 0 || output.signal !== null) throw new Error(`D1 recovery test failed\n${output.text}`)
    const receipt = output.text.split(/\r?\n/).find((line) => line.startsWith("RECOVERY_D1_RESULT "))
    expect(receipt).toBeDefined()
    const result = JSON.parse(receipt!.slice("RECOVERY_D1_RESULT ".length))
    expect(result.ok).toBe(true)
    expect(result.checks).toBeGreaterThanOrEqual(100)
    console.log(`Recovery D1: ${result.checks} checks passed`)
  } finally {
    const inside = relative(tmpdir(), directory)
    if (!inside || inside.startsWith("..") || isAbsolute(inside)) throw new Error("Recovery bundle escaped temp root")
    await rm(directory, { recursive: true, force: true })
  }
}, 130_000)
