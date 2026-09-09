import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

test("account deletion admission uses actual D1 batches and preserves concurrent state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mongolgpt-deletion-native-"))
  try {
    const build = await Bun.build({
      entrypoints: [fileURLToPath(new URL("./fixtures/account-deletion-native.ts", import.meta.url))],
      outdir: directory,
      naming: "deletion.mjs",
      target: "node",
    })
    if (!build.success) throw new Error(`Deletion fixture build failed: ${build.logs.join("\n")}`)
    const node = Bun.which("node")
    if (!node) throw new Error("Node is required for the local D1 deletion test")
    const child = spawn(
      node,
      ["--experimental-strip-types", "test/account-deletion-d1.integration.ts", join(directory, "deletion.mjs")],
      {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        windowsHide: true,
        env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
    const output = await new Promise<{
      code: number | null
      signal: NodeJS.Signals | null
      stdout: string
      stderr: string
    }>((resolve, reject) => {
      let stdout = ""
      let stderr = ""
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill("SIGTERM")
      }, 120_000)
      child.stdout.on("data", (chunk) => {
        stdout = (stdout + chunk).slice(-16000)
      })
      child.stderr.on("data", (chunk) => {
        stderr = (stderr + chunk).slice(-16000)
      })
      child.once("error", (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once("close", (code, signal) => {
        clearTimeout(timer)
        if (timedOut) return reject(new Error(`D1 deletion test timed out\n${stdout}\n${stderr}`))
        resolve({ code, signal, stdout, stderr })
      })
    })
    if (output.code !== 0 || output.signal !== null)
      throw new Error(`D1 deletion test failed\n${output.stdout}\n${output.stderr}`)
    const receipt = output.stdout.split(/\r?\n/).find((line) => line.startsWith("DELETION_D1_RESULT "))
    expect(receipt).toBeDefined()
    const result = JSON.parse(receipt!.slice("DELETION_D1_RESULT ".length))
    expect(result.ok).toBe(true)
    expect(result.checks).toBeGreaterThanOrEqual(30)
    console.log(`Account deletion D1: ${result.checks} checks passed`)
  } finally {
    const inside = relative(tmpdir(), directory)
    if (!inside || inside.startsWith("..") || isAbsolute(inside)) throw new Error("Deletion bundle escaped temp root")
    await rm(directory, { recursive: true, force: true })
  }
}, 130_000)
