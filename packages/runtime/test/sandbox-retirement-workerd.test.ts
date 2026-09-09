import { expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

test("sandbox retirement survives actual workerd DO re-instantiation and D1 admission checks", async () => {
  const node = Bun.which("node")
  if (!node) throw new Error("Node is required for the workerd retirement test")
  const child = spawn(node, ["--experimental-strip-types", "test/sandbox-retirement-workerd.integration.ts"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    windowsHide: true,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  })
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
    }, 90_000)
    child.stdout.on("data", (chunk) => (stdout = (stdout + chunk).slice(-16000)))
    child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-16000)))
    child.once("error", (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once("close", (code, signal) => {
      clearTimeout(timeout)
      if (timedOut)
        return reject(new Error(`retirement test timed out\n${stdout.slice(-2000)}\n${stderr.slice(-2000)}`))
      resolve({ code, signal, stdout, stderr })
    })
  })
  if (output.code !== 0 || output.signal !== null)
    throw new Error(
      `retirement test failed (${output.code}, ${output.signal})\n${output.stdout.slice(-3000)}\n${output.stderr.slice(-3000)}`,
    )
  const line = output.stdout.split(/\r?\n/).find((value) => value.startsWith("SANDBOX_RETIREMENT_RESULT "))
  expect(line).toBeDefined()
  const result = JSON.parse(line!.slice("SANDBOX_RETIREMENT_RESULT ".length))
  expect(result.ok).toBe(true)
  expect(result.assertions).toBeGreaterThanOrEqual(30)
  expect(result.realD1).toBe(true)
  expect(result.realDurableStorage).toBe(true)
  expect(result.realDOReinstantiation).toBe(true)
  expect(result.simulatedContainer).toBe(true)
  console.log(`Retirement workerd: ${result.assertions} assertions passed; container boundary simulated`)
}, 100_000)
