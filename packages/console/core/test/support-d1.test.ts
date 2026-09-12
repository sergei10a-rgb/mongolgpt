import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

test("support messages, limits, live authorization and admin audits are atomic on real D1", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mongolgpt-support-native-"))
  try {
    const build = await Bun.build({
      entrypoints: [fileURLToPath(new URL("./fixtures/support-native.ts", import.meta.url))],
      outdir: directory,
      naming: "support.mjs",
      target: "node",
    })
    if (!build.success) throw new Error(`Support fixture build failed: ${build.logs.join("\n")}`)
    const node = Bun.which("node")
    if (!node) throw new Error("Node is required for the local D1 support test")
    const child = spawn(
      node,
      ["--experimental-strip-types", "test/support-d1.integration.ts", join(directory, "support.mjs")],
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
        }, 120000)
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
          if (timedOut) return reject(new Error(`D1 support test timed out\n${text}`))
          resolve({ code, signal, text })
        })
      },
    )
    if (output.code !== 0 || output.signal !== null) throw new Error(`D1 support test failed\n${output.text}`)
    const receipt = output.text.split(/\r?\n/).find((line) => line.startsWith("SUPPORT_D1_RESULT "))
    expect(receipt).toBeDefined()
    const result = JSON.parse(receipt!.slice("SUPPORT_D1_RESULT ".length))
    expect(result.ok).toBe(true)
    expect(result.checks).toBeGreaterThanOrEqual(80)
    console.log(`Support D1: ${result.checks} checks passed`)
  } finally {
    const inside = relative(tmpdir(), directory)
    if (!inside || inside.startsWith("..") || isAbsolute(inside)) throw new Error("Support bundle escaped temp root")
    await rm(directory, { recursive: true, force: true })
  }
}, 130000)
