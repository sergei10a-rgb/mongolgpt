import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

test("actual scheduled heartbeat crosses Queue and KV into admin readiness", async () => {
  const node = Bun.which("node")
  if (!node) throw new Error("Node is required for the usage queue integration test")
  const child = spawn(node, ["--experimental-strip-types", "test/usage-queue.integration.ts"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    windowsHide: true,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  })
  const output = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; text: string }>(
    (resolve, reject) => {
      let text = ""
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill("SIGTERM")
      }, 60_000)
      child.stdout.on("data", (chunk) => (text = (text + chunk).slice(-8_000)))
      child.stderr.on("data", (chunk) => (text = (text + chunk).slice(-8_000)))
      child.once("error", (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once("close", (code, signal) => {
        clearTimeout(timer)
        if (timedOut) return reject(new Error(`Usage queue integration timed out\n${text}`))
        resolve({ code, signal, text })
      })
    },
  )
  if (output.code !== 0 || output.signal !== null)
    throw new Error(`Usage queue integration failed (${output.code}, ${output.signal})\n${output.text}`)
  const prefix = "USAGE_QUEUE_RESULT "
  const line = output.text.split(/\r?\n/).find((value) => value.startsWith(prefix))
  expect(line).toBeDefined()
  const result = JSON.parse(line!.slice(prefix.length))
  expect(result.ok).toBe(true)
  expect(result.assertions).toBeGreaterThanOrEqual(12)
  for (const flag of ["realQueue", "realKV", "realScheduledHandler", "realAdminReadiness"])
    expect(result[flag]).toBe(true)
  console.log(`Local usage queue: ${result.assertions} assertions passed`)
}, 70_000)
