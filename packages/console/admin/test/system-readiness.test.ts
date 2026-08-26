import { describe, expect, test } from "bun:test"
import { collectSystemReadiness, type SystemReadinessDependencies } from "../src/lib/system-readiness"

const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  })

const now = new Date("2026-08-19T00:00:00.000Z")

const queueHeartbeat = () =>
  JSON.stringify({
    version: 1,
    id: "heartbeat-secret-id",
    sentAt: now.getTime() - 60_000,
    processedAt: now.getTime() - 30_000,
  })

const monitorEvidence = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: 1,
    stage: "dev",
    checkedAt: now.getTime() - 60_000,
    status: "ok",
    checks: ["console", "auth", "runtime", "payments"].map((service) => ({
      service,
      ok: true,
      httpStatus: 200,
      latencyMs: 25,
    })),
    ...overrides,
  })

const backup = (overrides: Record<string, unknown> = {}) => ({
  key: "d1/dev/2026/08/18/2026-08-18T23-55-00.000Z-database.sql",
  size: 1_024,
  uploaded: new Date("2026-08-18T23:56:00.000Z"),
  customMetadata: {
    createdAt: "2026-08-18T23:55:00.000Z",
    source: "cloudflare-d1-export",
    stage: "dev",
  },
  ...overrides,
})

function dependencies(overrides: Partial<SystemReadinessDependencies> = {}): SystemReadinessDependencies {
  return {
    stage: "dev",
    runtimeURL: "https://runtime.dev.mgpt.mn",
    backupsEnabled: true,
    monitoringEnabled: true,
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
    queueHeartbeat: async () => queueHeartbeat(),
    monitorEvidence: async () => monitorEvidence(),
    backups: async () => ({ objects: [backup()] }),
    now: () => now,
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
      "usage-queue": "healthy",
      payments: "healthy",
      monitoring: "healthy",
      backup: "healthy",
    })
    expect(JSON.stringify(report)).not.toContain("heartbeat-secret-id")
    expect(JSON.stringify(report)).not.toContain("database.sql")
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
        queueHeartbeat: async () => null,
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
      monitoring: "healthy",
      backup: "degraded",
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

  test("fails stale or malformed queue heartbeat evidence closed", async () => {
    const evidence = [
      "not-json",
      JSON.stringify({
        version: 1,
        id: "stale",
        sentAt: now.getTime() - 1_000_000,
        processedAt: now.getTime() - 950_000,
      }),
      JSON.stringify({ version: 1, id: "reversed", sentAt: now.getTime(), processedAt: now.getTime() - 1 }),
      JSON.stringify({
        version: 1,
        id: "future",
        sentAt: now.getTime() + 180_000,
        processedAt: now.getTime() + 180_000,
      }),
    ]

    for (const value of evidence) {
      const report = await collectSystemReadiness(dependencies({ queueHeartbeat: async () => value }))
      expect(report.checks.find((check) => check.id === "usage-queue")?.state).toBe("degraded")
    }
  })

  test("requires recent, bounded D1 export evidence for the active stage", async () => {
    const objects = [
      backup({
        key: "d1/dev/2026/08/17/2026-08-17T00-00-00.000Z-database.sql",
        uploaded: new Date("2026-08-17T00:01:00.000Z"),
        customMetadata: {
          createdAt: "2026-08-17T00:00:00.000Z",
          source: "cloudflare-d1-export",
          stage: "dev",
        },
      }),
      backup({ key: "d1/production/2026/08/18/2026-08-18T23-55-00.000Z-database.sql" }),
      backup({ size: 10 * 1024 * 1024 * 1024 + 1 }),
      backup({ customMetadata: { createdAt: "2026-08-18T23:55:00.000Z", source: "unknown", stage: "dev" } }),
    ]

    for (const object of objects) {
      const report = await collectSystemReadiness(dependencies({ backups: async () => ({ objects: [object] }) }))
      expect(report.checks.find((check) => check.id === "backup")?.state).toBe("degraded")
    }
  })

  test("fails stale, malformed, wrong-stage, or degraded monitoring evidence closed", async () => {
    const evidence = [
      "not-json",
      monitorEvidence({ checkedAt: now.getTime() - 1_000_000 }),
      monitorEvidence({ stage: "production" }),
      monitorEvidence({
        status: "degraded",
        checks: [
          { service: "console", ok: false, httpStatus: 503, latencyMs: 25, failure: "http" },
          ...["auth", "runtime", "payments"].map((service) => ({
            service,
            ok: true,
            httpStatus: 200,
            latencyMs: 25,
          })),
        ],
      }),
    ]

    for (const value of evidence) {
      const report = await collectSystemReadiness(dependencies({ monitorEvidence: async () => value }))
      expect(report.checks.find((check) => check.id === "monitoring")?.state).toBe("degraded")
    }
  })

  test("reports disabled monitoring without reading its KV state", async () => {
    let probed = false
    const report = await collectSystemReadiness(
      dependencies({
        monitoringEnabled: false,
        monitorEvidence: async () => {
          probed = true
          throw new Error("must not run")
        },
      }),
    )

    expect(probed).toBe(false)
    expect(report.status).toBe("degraded")
    expect(report.checks.find((check) => check.id === "monitoring")?.state).toBe("disabled")
  })

  test("reports disabled backup automation without probing R2", async () => {
    let probed = false
    const report = await collectSystemReadiness(
      dependencies({
        backupsEnabled: false,
        backups: async () => {
          probed = true
          throw new Error("must not run")
        },
      }),
    )

    expect(probed).toBe(false)
    expect(report.status).toBe("degraded")
    expect(report.checks.find((check) => check.id === "backup")?.state).toBe("disabled")
  })
})
