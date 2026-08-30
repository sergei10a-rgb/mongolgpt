import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

describe("gateway handler HTTP boundary", () => {
  test("runs the authenticated Free Auto fallback check in an isolated module graph", async () => {
    const result = await runCheck()
    const output = result.stdout + result.stderr

    expect(result.code).toBe(0)
    expect(output).toContain("2 pass")
    expect(output).toContain("0 fail")
  })
})

function runCheck() {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["test", fileURLToPath(new URL("./handler.e2e-check.ts", import.meta.url))], {
      stdio: ["ignore", "pipe", "pipe"],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error("Gateway handler E2E шалгалтын хугацаа дууслаа"))
    }, 30_000)

    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)))
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)))
    child.once("error", reject)
    child.once("close", (code) => {
      clearTimeout(timeout)
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      })
    })
  })
}
