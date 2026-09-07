import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative } from "node:path"

test("runs real local D1 history persistence and concurrency checks under Node", async () => {
  const node = Bun.which("node")
  if (!node) throw new Error("Node is required for the local D1 integration harness")
  const bundle = await mkdtemp(join(tmpdir(), "mongolgpt-history-rpc-"))
  try {
    const build = await Bun.build({
      entrypoints: [fileURLToPath(new URL("./fixtures/history-native.ts", import.meta.url))],
      outdir: bundle,
      naming: "history-rpc.mjs",
      target: "node",
    })
    if (!build.success) throw new Error(`history RPC build failed: ${build.logs.join("\n")}`)

    const child = spawn(
      node,
      ["--experimental-strip-types", "test/history-d1.integration.ts", join(bundle, "history-rpc.mjs")],
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
      const timeout = setTimeout(() => {
        timedOut = true
        child.kill("SIGTERM")
      }, 120_000)
      child.stdout.on("data", (chunk) => (stdout = (stdout + chunk).slice(-16000)))
      child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-16000)))
      child.once("error", (error) => {
        clearTimeout(timeout)
        reject(error)
      })
      child.once("close", (code, signal) => {
        clearTimeout(timeout)
        if (timedOut)
          return reject(new Error(`local D1 integration timed out\n${stdout.slice(-2000)}\n${stderr.slice(-2000)}`))
        resolve({ code, signal, stdout, stderr })
      })
    })

    if (output.code !== 0 || output.signal !== null) {
      throw new Error(
        `local D1 integration failed (code=${output.code}, signal=${output.signal})\nstdout: ${output.stdout.slice(-2000)}\nstderr: ${output.stderr.slice(-2000)}`,
      )
    }
    const resultLine = output.stdout.split(/\r?\n/).find((line) => line.startsWith("HISTORY_D1_RESULT "))
    expect(resultLine).toBeDefined()
    const result = JSON.parse(resultLine!.slice("HISTORY_D1_RESULT ".length))
    expect(result.ok).toBe(true)
    expect(typeof result.assertions).toBe("number")
    expect(result.assertions).toBeGreaterThanOrEqual(40)
    console.log(`Local D1: ${result.assertions} assertions passed`)
  } finally {
    const inside = relative(tmpdir(), bundle)
    if (!inside || inside.startsWith("..") || isAbsolute(inside))
      throw new Error("history RPC cleanup escaped temp root")
    await rm(bundle, { recursive: true, force: true })
  }
}, 130_000)
