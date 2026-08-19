import { describe, expect, test } from "bun:test"
import { collectSystemReadiness, type SystemReadinessDependencies } from "../src/lib/system-readiness"

const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  })

function dependencies(overrides: Partial<SystemReadinessDependencies> = {}): SystemReadinessDependencies {
  return {
    stage: "dev",
    runtimeURL: "https://runtime.dev.mgpt.mn",
    database: async () => undefined,
    auth: async () => json({ status: "ok", service: "auth" }),
    quota: async () => json({ status: "ok", service: "quota", storage: "durable-objects", queue: "cloudflare-queues" }),
    payments: async () =>
      json({
        status: "ok",
        service: "payments",
        environment: "sandbox",
        providers: { qpay: true, bonum: true },
        catalog: true,
        checkout: true,
        cancellation: true,
      }),
    runtime: async () => json({ healthy: true, version: "0.1.1" }),
    backups: async () => ({ objects: [{ key: "hidden" }] }),
    now: () => new Date("2026-08-19T00:00:00.000Z"),
    ...overrides,
  }
}

describe("MongolGPT admin system readiness", () => {
  test("reports verified services without exposing provider secrets", async () => {
    const report = await collectSystemReadiness(dependencies())

    expect(report.status).toBe("ok")
    expect(report.stage).toBe("dev")
    expect(report.checkedAt).toBe("2026-08-19T00:00:00.000Z")
    expect(Object.fromEntries(report.checks.map((check) => [check.id, check.state]))).toEqual({
      database: "healthy",
      runtime: "healthy",
      oauth: "healthy",
      quota: "healthy",
      "usage-queue": "configured",
      payments: "healthy",
      backup: "healthy",
    })
    expect(JSON.stringify(report)).not.toContain("hidden")
  })

  test("fails individual checks closed while keeping the report available", async () => {
    const report = await collectSystemReadiness(
      dependencies({
        runtimeURL: "",
        database: async () => {
          throw new Error("secret database diagnostic")
        },
        auth: async () => new Response("<html>not json</html>", { status: 200 }),
        quota: async () => json({ status: "ok", service: "quota" }),
        payments: async () =>
          json({
            status: "disabled",
            service: "payments",
            environment: "disabled",
            providers: { qpay: false, bonum: false },
            catalog: false,
            checkout: false,
            cancellation: false,
          }),
        backups: async () => ({ objects: [] }),
      }),
    )

    expect(report.status).toBe("degraded")
    expect(Object.fromEntries(report.checks.map((check) => [check.id, check.state]))).toEqual({
      database: "degraded",
      runtime: "missing",
      oauth: "degraded",
      quota: "degraded",
      "usage-queue": "degraded",
      payments: "disabled",
      backup: "configured",
    })
    expect(JSON.stringify(report)).not.toContain("secret database diagnostic")
  })

  test("rejects HTTP success responses with the wrong health schema", async () => {
    const report = await collectSystemReadiness(
      dependencies({
        runtime: async () => json({ healthy: true }),
        auth: async () => json({ status: "ok", service: "auth", token: "must-not-pass" }),
      }),
    )

    expect(report.checks.find((check) => check.id === "runtime")?.state).toBe("degraded")
    expect(report.checks.find((check) => check.id === "oauth")?.state).toBe("degraded")
    expect(JSON.stringify(report)).not.toContain("must-not-pass")
  })
})
