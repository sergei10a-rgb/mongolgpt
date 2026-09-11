import { describe, expect, test } from "bun:test"
import candidate from "../wrangler.candidate.dev.json"
import storage from "../wrangler.storage.dev.json"
import packageJSON from "../package.json"
import { createRuntimeHandler } from "../src/runtime"

describe("persistent dev runtime candidate", () => {
  test("satisfies the actual handler configuration without starting a container", async () => {
    expect(candidate.vars.MONGOLGPT_RUNTIME_VERSION).toBe(packageJSON.version)
    const handler = createRuntimeHandler({
      sandbox: () => {
        throw new Error("Configuration validation must not start a container")
      },
    })
    const unusedLimiter = {
      limit: async () => {
        throw new Error("Configuration validation must not consume a quota")
      },
    }
    const env = {
      ...candidate.vars,
      MONGOLGPT_RUNTIME_SECRET: "r".repeat(32),
      MONGOLGPT_RUNTIME_AUTH_SECRET: "a".repeat(32),
      MONGOLGPT_RUNTIME_BURST_LIMITER: unusedLimiter,
      MONGOLGPT_RUNTIME_RATE_LIMITER: unusedLimiter,
    }
    const response = await handler(new Request("https://candidate.invalid/global/health"), env)
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("application/json")
    const body: unknown = await response.json()
    expect(body).toEqual({
      healthy: true,
      service: "mongolgpt-runtime",
      stage: "dev",
      version: packageJSON.version,
    })
    for (const key of ["MONGOLGPT_RUNTIME_SECRET", "MONGOLGPT_RUNTIME_AUTH_SECRET", "MONGOLGPT_RUNTIME_VERSION"]) {
      const invalid = await handler(new Request("https://candidate.invalid/global/health"), { ...env, [key]: "" })
      expect(invalid.status).toBe(503)
      expect(await invalid.json()).toMatchObject({ healthy: false })
    }
  })

  test("uses the prepared runtime storage, never the console database", () => {
    expect(candidate.account_id).toBe(storage.account_id)
    expect(candidate.d1_databases).toEqual(storage.d1_databases)
    expect(candidate.r2_buckets).toEqual(storage.r2_buckets)
    expect(candidate.vars.MONGOLGPT_CLOUD_HISTORY).toBe("true")
    expect(candidate.secrets.required).toEqual([
      "MONGOLGPT_RUNTIME_SECRET",
      "MONGOLGPT_RUNTIME_AUTH_SECRET",
      "MONGOLGPT_RUNTIME_BACKUP_KEYS",
    ])
  })

  test("has no public ingress or account-cleanup admission", () => {
    expect(candidate.workers_dev).toBe(false)
    expect(candidate.preview_urls).toBe(false)
    expect(candidate.routes).toEqual([])
    expect(candidate).not.toHaveProperty("route")
    expect(candidate).not.toHaveProperty("services")
    expect(candidate).not.toHaveProperty("queues")
    expect(candidate).not.toHaveProperty("triggers")
    expect(candidate).not.toHaveProperty("env")
    expect(candidate.vars.MONGOLGPT_RUNTIME_ACCOUNT_CLEANUP).toBe("false")
    expect(candidate.vars.STAGE).toBe("dev")
    expect(candidate.vars.MONGOLGPT_APP_ORIGIN).toBe("https://app.dev.mgpt.mn")
    expect(candidate.vars.MONGOLGPT_CONSOLE_URL).toBe("https://dev.mgpt.mn")
  })

  test("keeps a separate container and namespace from the legacy deployment", async () => {
    const primary = Bun.JSONC.parse(await Bun.file(new URL("../wrangler.dev.jsonc", import.meta.url)).text())
    if (
      !record(primary) ||
      !record(primary.secrets) ||
      !Array.isArray(primary.containers) ||
      !primary.containers.every(record) ||
      !Array.isArray(primary.ratelimits) ||
      !primary.ratelimits.every(record)
    )
      throw new Error("Legacy runtime deployment settings are invalid")
    expect(candidate.name).toBe("mongolgpt-runtime-candidate-dev")
    expect(candidate.name).not.toBe(primary.name)
    expect(primary.main).toBe(candidate.main)
    expect(primary.compatibility_date).toBe(candidate.compatibility_date)
    expect(primary.compatibility_flags).toEqual(candidate.compatibility_flags)
    const { name, ...container } = candidate.containers[0]
    expect(name).toBe(candidate.name)
    expect(candidate.containers).toHaveLength(1)
    expect(primary.containers).toEqual([container])
    expect(primary.durable_objects).toEqual(candidate.durable_objects)
    expect(primary.migrations).toEqual(candidate.migrations)
    for (const binding of candidate.durable_objects.bindings) {
      expect(binding).not.toHaveProperty("script_name")
      expect(binding).not.toHaveProperty("environment")
    }
    for (const limit of candidate.ratelimits) {
      const previous = primary.ratelimits.find((item) => item.name === limit.name)
      expect(previous).toBeDefined()
      if (!previous) throw new Error("Legacy runtime rate limiter is missing")
      expect(previous.simple).toEqual(limit.simple)
      expect(candidate.ratelimits.filter((item) => item.namespace_id === limit.namespace_id)).toHaveLength(1)
      expect(primary.ratelimits.some((item) => item.namespace_id === limit.namespace_id)).toBe(false)
    }
    // Adding a candidate must not silently activate new persistence on the old VM.
    expect(primary).not.toHaveProperty("d1_databases")
    expect(primary).not.toHaveProperty("r2_buckets")
    expect(primary.secrets.required).not.toContain("MONGOLGPT_RUNTIME_BACKUP_KEYS")
  })
})

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
