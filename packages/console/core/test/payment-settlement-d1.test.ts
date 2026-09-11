import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

test("payment event and entitlement settlement stays atomic on real D1", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mongolgpt-settlement-native-"))
  try {
    const build = await Bun.build({
      entrypoints: [fileURLToPath(new URL("./fixtures/payment-settlement-native.ts", import.meta.url))],
      outdir: directory,
      naming: "settlement.mjs",
      target: "node",
    })
    if (!build.success) throw new Error(`Settlement fixture build failed: ${build.logs.join("\n")}`)
    const node = Bun.which("node")
    if (!node) throw new Error("Node is required for the local D1 settlement test")
    const child = spawn(
      node,
      ["--experimental-strip-types", "test/payment-settlement-d1.integration.ts", join(directory, "settlement.mjs")],
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
          if (timedOut) return reject(new Error(`D1 settlement test timed out\n${text}`))
          resolve({ code, signal, text })
        })
      },
    )
    if (output.code !== 0 || output.signal !== null) throw new Error(`D1 settlement test failed\n${output.text}`)
    const receipt = output.text.split(/\r?\n/).find((line) => line.startsWith("SETTLEMENT_D1_RESULT "))
    expect(receipt).toBeDefined()
    const result = JSON.parse(receipt!.slice("SETTLEMENT_D1_RESULT ".length))
    expect(result.ok).toBe(true)
    expect(result.checks).toBeGreaterThanOrEqual(60)
    console.log(`Settlement D1: ${result.checks} checks passed`)
  } finally {
    const inside = relative(tmpdir(), directory)
    if (!inside || inside.startsWith("..") || isAbsolute(inside)) throw new Error("Settlement bundle escaped temp root")
    await rm(directory, { recursive: true, force: true })
  }
}, 130_000)
