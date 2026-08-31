import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { inspectSstErrorDiagnostics } from "../src/sst-error-diagnostics"

describe("SST Pulumi error diagnostics", () => {
  test("keeps only bounded error diagnostics and redacts sensitive values", () => {
    const secret = "secret-value-that-must-never-appear"
    const input = [
      event("info", "ignore this"),
      event(
        "error",
        `provider rejected token=${secret} for owner@example.com at https://api.example.com/path?q=${secret}`,
        "urn:pulumi:dev::mongolgpt::cloudflare:index/zeroTrustAccessApplication:ZeroTrustAccessApplication::AdminAccessApplication",
      ),
      event("error", `different provider error with key=${secret} and Bearer bearer-token-value-1234567890`),
      "partial-json",
    ].join("\n")

    const result = inspectSstErrorDiagnostics(input, [secret])

    expect(result).toHaveLength(2)
    expect(result[0]?.resource).toBe(
      "cloudflare:index/zeroTrustAccessApplication:ZeroTrustAccessApplication AdminAccessApplication",
    )
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(JSON.stringify(result)).not.toContain("owner@example.com")
    expect(JSON.stringify(result)).not.toContain("api.example.com")
    expect(JSON.stringify(result)).not.toContain("bearer-token-value")
    expect(result[0]?.message).toContain("token=[redacted]")
    expect(result[0]?.message).toContain("[email]")
    expect(result[0]?.message).toContain("[url]")
  })

  test("accepts a JSON array and caps duplicate-free output", () => {
    const input = JSON.stringify(
      Array.from({ length: 20 }, (_, index) => ({
        diagnosticEvent: { severity: "error", message: `error ${index}` },
      })),
    )
    const result = inspectSstErrorDiagnostics(input)
    expect(result).toHaveLength(12)
    expect(inspectSstErrorDiagnostics(`${event("error", "same")}\n${event("error", "same")}`)).toEqual([
      { message: "same" },
    ])
  })

  test("returns an empty list for malformed or non-error logs", () => {
    expect(inspectSstErrorDiagnostics("not-json")).toEqual([])
    expect(inspectSstErrorDiagnostics(event("warning", "warning only"))).toEqual([])
  })

  test("CLI prints only redacted diagnostics from a bounded event log", async () => {
    const root = await mkdtemp(join(tmpdir(), "mongolgpt-sst-diagnostics-"))
    const eventRoot = join(root, "preview")
    const secret = "cli-secret-value-that-must-not-leak"
    try {
      await mkdir(eventRoot)
      await writeFile(
        join(eventRoot, "eventlog.json"),
        event(
          "error",
          `token=${secret} owner@example.com https://api.example.com/private`,
          "urn:pulumi:dev::mongolgpt::cloudflare:index/worker:Worker::AdminServer",
        ),
      )
      const child = Bun.spawn(
        [process.execPath, join(import.meta.dir, "../../../script/sst-error-diagnostics.ts"), root],
        {
          env: { ...globalThis.process.env, TEST_SECRET: secret },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(exitCode).toBe(0)
      expect(stdout).toBe("")
      expect(stderr).toContain("Pulumi preview-ийн нууц утгагүй error diagnostics")
      expect(stderr).toContain("token=[redacted]")
      expect(stderr).not.toContain(secret)
      expect(stderr).not.toContain("owner@example.com")
      expect(stderr).not.toContain("api.example.com")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

function event(severity: string, message: string, urn?: string) {
  return JSON.stringify({ diagnosticEvent: { severity, message, ...(urn ? { urn } : {}) } })
}
