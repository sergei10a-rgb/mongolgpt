import { describe, expect, test } from "bun:test"
import { isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  CanaryResourceError,
  createCanaryConfig,
  createCanaryName,
  createCanaryResources,
  cleanupCanaryResourceReceipt,
  type CanaryRequest,
} from "../script/canary-resources"

const accountID = "0123456789abcdef0123456789abcdef"
const token = "test-token-that-is-never-sent-to-real-cloudflare"
const name = "mgpt-canary-123456789012-123"
const databaseID = "11111111-2222-4333-8444-555555555555"
const containerID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
const namespaceID = "99999999-8888-4777-9666-555555555555"

describe("canary resource provisioning", () => {
  test("validates fixed canary naming inputs without accepting arbitrary names", async () => {
    expect(createCanaryName("1", "1")).toBe("mgpt-canary-1-1")
    expect(createCanaryName("123456789012", "123")).toBe(name)
    expect(() => createCanaryName("", "1")).toThrow("runID")
    expect(() => createCanaryName("1234567890123", "1")).toThrow("runID")
    expect(() => createCanaryName("1", "1234")).toThrow("attempt")
    await expect(
      createCanaryResources({ accountID: "0123456789ABCDEf0123456789abcdef", token, runID: "1", attempt: "1" }),
    ).rejects.toThrow("accountID")
  })

  test("preflights exact Worker, R2 bucket, and D1 name before creating fresh resources", async () => {
    const api = cloudflareMock()

    const resources = await createCanaryResources({
      accountID,
      token,
      runID: "123456789012",
      attempt: "123",
      request: api.fetch,
    })

    expect(resources).toMatchObject({
      name,
      databaseID,
      subdomain: "example-subdomain",
    })
    expect(api.calls.map((call) => [call.method, call.path])).toEqual([
      ["GET", `/accounts/${accountID}/workers/scripts/${name}/settings`],
      ["GET", `/accounts/${accountID}/r2/buckets/${name}`],
      ["GET", `/accounts/${accountID}/d1/database?name=${name}&per_page=50`],
      ["GET", `/accounts/${accountID}/workers/subdomain`],
      ["POST", `/accounts/${accountID}/d1/database`],
      ["POST", `/accounts/${accountID}/r2/buckets`],
    ])
    expect(api.calls.every((call) => call.authorization === `Bearer ${token}`)).toBe(true)
    expect(JSON.parse(api.calls[4]!.body)).toEqual({ name })
    expect(JSON.parse(api.calls[5]!.body)).toEqual({ name })
    expect(api.calls.every((call) => call.signal instanceof AbortSignal)).toBe(true)
    expect(api.calls.every((call) => call.redirect === "error")).toBe(true)
  })

  test("rejects any pre-existing exact resource instead of reusing it", async () => {
    await expect(
      createCanaryResources({
        accountID,
        token,
        runID: "123456789012",
        attempt: "123",
        request: cloudflareMock({ workerExists: true }).fetch,
      }),
    ).rejects.toMatchObject({ message: `Canary Worker already exists: ${name}` })

    await expect(
      createCanaryResources({
        accountID,
        token,
        runID: "123456789012",
        attempt: "123",
        request: cloudflareMock({ bucketExists: true }).fetch,
      }),
    ).rejects.toMatchObject({ message: `Canary R2 bucket already exists: ${name}` })

    await expect(
      createCanaryResources({
        accountID,
        token,
        runID: "123456789012",
        attempt: "123",
        request: cloudflareMock({ databaseExists: true }).fetch,
      }),
    ).rejects.toMatchObject({ message: `Canary D1 database already exists: ${name}` })
  })

  test("cleans up only confirmed allocations and reports uncertain creates for manual cleanup", async () => {
    const api = cloudflareMock({ failR2Create: true })

    try {
      await createCanaryResources({
        accountID,
        token,
        runID: "123456789012",
        attempt: "123",
        request: api.fetch,
      })
      throw new Error("expected provisioning failure")
    } catch (error) {
      expect(error).toBeInstanceOf(CanaryResourceError)
      const canaryError = error as CanaryResourceError
      expect(canaryError.message).not.toContain(token)
      expect(canaryError.manualCleanup).toContain(`r2:${name}:creation-status-uncertain`)
      expect(canaryError.cleanup?.deleted).toEqual([`d1:${databaseID}`])
      expect(canaryError.cleanup?.skipped).toContain(`worker:${name}:not-marked-created`)
      expect(canaryError.cleanup?.skipped).toContain(`r2:${name}:not-confirmed-created`)
    }

    expect(api.calls.map((call) => [call.method, call.path])).toContainEqual([
      "DELETE",
      `/accounts/${accountID}/d1/database/${databaseID}`,
    ])
    expect(api.calls.map((call) => call.path)).not.toContain(`/accounts/${accountID}/r2/buckets/${name}?force=true`)
    expect(api.calls.filter((call) => call.method === "DELETE" && call.path.includes("/r2/buckets"))).toHaveLength(0)
  })

  test("persists each confirmed allocation before the next network create", async () => {
    const api = cloudflareMock()
    const receipts: unknown[] = []
    await createCanaryResources({
      accountID,
      token,
      runID: "123456789012",
      attempt: "123",
      request: api.fetch,
      onReceipt: async (receipt) => {
        receipts.push({ receipt, creates: api.calls.filter((call) => call.method === "POST").length })
      },
    })
    expect(receipts).toEqual([
      { receipt: { name, databaseID, r2BucketCreated: false, workerDeployed: false }, creates: 1 },
      { receipt: { name, databaseID, r2BucketCreated: true, workerDeployed: false }, creates: 2 },
    ])
    const failed = cloudflareMock()
    await expect(
      createCanaryResources({
        accountID,
        token,
        runID: "123456789012",
        attempt: "123",
        request: failed.fetch,
        onReceipt: async () => {
          throw new Error("cannot persist receipt")
        },
      }),
    ).rejects.toThrow("cannot persist receipt")
    expect(failed.calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual([
      `/accounts/${accountID}/d1/database/${databaseID}`,
    ])
    expect(failed.calls.filter((call) => call.method === "POST")).toHaveLength(1)
  })

  test("cleanup deletes Worker, Container app, R2, and D1 only after exact ownership guards", async () => {
    const api = cloudflareMock({ containerDelete204: true })
    const resources = await createCanaryResources({
      accountID,
      token,
      runID: "123456789012",
      attempt: "123",
      request: api.fetch,
    })

    const cleanup = await resources.cleanup({
      workerDeployed: true,
      containerApplicationID: containerID,
      purge: async () => {},
    })

    expect(cleanup.failures).toEqual([])
    expect(cleanup.deleted).toEqual([`worker:${name}`, `container:${containerID}`, `r2:${name}`, `d1:${databaseID}`])
    expect(api.calls.map((call) => [call.method, call.path]).slice(-8)).toEqual([
      ["GET", `/accounts/${accountID}/workers/scripts/${name}/settings`],
      ["GET", `/accounts/${accountID}/containers/applications/${containerID}`],
      ["DELETE", `/accounts/${accountID}/workers/scripts/${name}`],
      ["DELETE", `/accounts/${accountID}/containers/applications/${containerID}`],
      ["GET", `/accounts/${accountID}/r2/buckets/${name}`],
      ["DELETE", `/accounts/${accountID}/r2/buckets/${name}`],
      ["GET", `/accounts/${accountID}/d1/database/${databaseID}`],
      ["DELETE", `/accounts/${accountID}/d1/database/${databaseID}`],
    ])
    expect(api.calls.find((call) => call.method === "DELETE" && call.path.includes("/r2/buckets"))?.path).toBe(
      `/accounts/${accountID}/r2/buckets/${name}`,
    )
  })

  test("cleanup fails closed on mismatched Worker, Container, bucket, or D1 metadata", async () => {
    const api = cloudflareMock({
      cleanupWorkerName: "mongolgpt-runtime-dev",
      cleanupBucketName: "prod-backups",
      cleanupDatabaseName: "mongolgpt-runtime-dev",
      cleanupContainerNamespaceID: "22222222-2222-4222-8222-222222222222",
    })
    const resources = await createCanaryResources({
      accountID,
      token,
      runID: "123456789012",
      attempt: "123",
      request: api.fetch,
    })

    const cleanup = await resources.cleanup({
      workerDeployed: true,
      containerApplicationID: containerID,
      purge: async () => {},
    })

    expect(cleanup.deleted).toEqual([])
    expect(cleanup.failures).toEqual([{ resource: `worker:${name}`, message: "history-binding-mismatch" }])
    expect(cleanup.skipped).toEqual([`r2:${name}:frontend-cleanup-failed`, `d1:${databaseID}:frontend-cleanup-failed`])
    expect(cleanup.manualCleanup).toEqual([`worker:${name}`, `r2:${name}`, `d1:${databaseID}`])
    expect(api.calls.filter((call) => call.method === "DELETE")).toEqual([])
  })

  test("cleanup treats mismatched backend metadata as failures", async () => {
    const api = cloudflareMock({ cleanupBucketName: "prod-backups", cleanupDatabaseName: "mongolgpt-runtime-dev" })
    const resources = await createCanaryResources({
      accountID,
      token,
      runID: "123456789012",
      attempt: "123",
      request: api.fetch,
    })

    const cleanup = await resources.cleanup({ workerDeployed: false })

    expect(cleanup.deleted).toEqual([])
    expect(cleanup.failures).toEqual([{ resource: `r2:${name}`, message: "name-mismatch" }])
    expect(cleanup.skipped).toContain(`d1:${databaseID}:backend-cleanup-failed`)
    expect(api.calls.filter((call) => call.path.endsWith(`/d1/database/${databaseID}`))).toEqual([])
    expect(cleanup.manualCleanup).toEqual([`r2:${name}`, `d1:${databaseID}`])
  })

  test("retains D1 after a nonempty bucket refuses deletion", async () => {
    const api = cloudflareMock({ failR2Delete: true })
    const resources = await createCanaryResources({
      accountID,
      token,
      runID: "123456789012",
      attempt: "123",
      request: api.fetch,
    })
    const result = await resources.cleanup({
      workerDeployed: true,
      containerApplicationID: containerID,
      purge: async () => {},
    })
    expect(result.deleted).toEqual([`worker:${name}`, `container:${containerID}`])
    expect(result.failures[0]?.resource).toBe(`r2:${name}`)
    expect(result.manualCleanup).toEqual([`r2:${name}`, `d1:${databaseID}`])
    expect(api.calls.filter((call) => call.path.endsWith(`/d1/database/${databaseID}`))).toEqual([])
  })

  test("D1 name mismatch still blocks deletion after successful bucket cleanup", async () => {
    const api = cloudflareMock({ cleanupDatabaseName: "mongolgpt-runtime-dev" })
    const resources = await createCanaryResources({
      accountID,
      token,
      runID: "123456789012",
      attempt: "123",
      request: api.fetch,
    })
    const result = await resources.cleanup({ workerDeployed: false })
    expect(result.deleted).toEqual([`r2:${name}`])
    expect(result.failures).toEqual([{ resource: `d1:${databaseID}`, message: "name-mismatch" }])
    expect(api.calls.filter((call) => call.method === "DELETE" && call.path.includes("/d1/"))).toEqual([])
  })

  test("does not delete R2 or D1 when purge or frontend cleanup fails", async () => {
    const api = cloudflareMock()
    const resources = await createCanaryResources({
      accountID,
      token,
      runID: "123456789012",
      attempt: "123",
      request: api.fetch,
    })

    const cleanup = await resources.cleanup({
      workerDeployed: true,
      containerApplicationID: containerID,
      purge: async () => {
        throw new Error(`purge failed ${token}`)
      },
    })

    expect(cleanup.failures).toEqual([{ resource: `purge:${name}`, message: "purge failed [redacted]" }])
    expect(cleanup.deleted).toEqual([])
    expect(cleanup.skipped).toEqual([`r2:${name}:frontend-cleanup-failed`, `d1:${databaseID}:frontend-cleanup-failed`])
    expect(cleanup.manualCleanup).toEqual([`r2:${name}:purge-failed`, `r2:${name}`, `d1:${databaseID}`])
    expect(api.calls.filter((call) => call.method === "DELETE")).toEqual([])
  })

  test("discovers a verified container app by exact canary name and namespace", async () => {
    const api = cloudflareMock({ discoverContainer: true })
    const resources = await createCanaryResources({
      accountID,
      token,
      runID: "123456789012",
      attempt: "123",
      request: api.fetch,
    })

    const cleanup = await resources.cleanup({ workerDeployed: true, purge: async () => {} })

    expect(cleanup.failures).toEqual([])
    expect(cleanup.deleted).toEqual([`worker:${name}`, `container:${containerID}`, `r2:${name}`, `d1:${databaseID}`])
    expect(api.calls.map((call) => [call.method, call.path]).slice(-9)).toEqual([
      ["GET", `/accounts/${accountID}/workers/scripts/${name}/settings`],
      ["GET", `/accounts/${accountID}/containers/applications?name=${name}`],
      ["GET", `/accounts/${accountID}/containers/applications/${containerID}`],
      ["DELETE", `/accounts/${accountID}/workers/scripts/${name}`],
      ["DELETE", `/accounts/${accountID}/containers/applications/${containerID}`],
      ["GET", `/accounts/${accountID}/r2/buckets/${name}`],
      ["DELETE", `/accounts/${accountID}/r2/buckets/${name}`],
      ["GET", `/accounts/${accountID}/d1/database/${databaseID}`],
      ["DELETE", `/accounts/${accountID}/d1/database/${databaseID}`],
    ])
  })

  test("container app discovery fails closed on invalid list shape or duplicate exact names", async () => {
    for (const api of [
      cloudflareMock({ discoverContainerInvalidShape: true }),
      cloudflareMock({ discoverContainerDuplicates: true }),
    ]) {
      const resources = await createCanaryResources({
        accountID,
        token,
        runID: "123456789012",
        attempt: "123",
        request: api.fetch,
      })

      const cleanup = await resources.cleanup({ workerDeployed: true, purge: async () => {} })

      expect(cleanup.deleted).toEqual([])
      expect(cleanup.failures.length).toBeGreaterThanOrEqual(1)
      expect(cleanup.skipped).toEqual([
        `r2:${name}:frontend-cleanup-failed`,
        `d1:${databaseID}:frontend-cleanup-failed`,
      ])
      expect(api.calls.filter((call) => call.method === "DELETE")).toEqual([])
    }
  })

  test("rejects invalid D1 list response shape during preflight", async () => {
    await expect(
      createCanaryResources({
        accountID,
        token,
        runID: "123456789012",
        attempt: "123",
        request: cloudflareMock({ invalidD1List: true }).fetch,
      }),
    ).rejects.toThrow("Cloudflare D1 list response shape is invalid.")
  })

  test("redacts the exact Cloudflare token even when it is short", async () => {
    const shortToken = "shorttok"

    await expect(
      createCanaryResources({
        accountID,
        token: shortToken,
        runID: "123456789012",
        attempt: "123",
        request: async () =>
          Response.json(
            { success: false, errors: [{ code: 10000, message: `bad credential ${shortToken}` }] },
            { status: 500 },
          ),
      }),
    ).rejects.toMatchObject({ message: expect.not.stringContaining(shortToken) })
  })

  test("deployed resources cannot be deleted without the stop-and-purge callback", async () => {
    const api = cloudflareMock()
    const resources = await createCanaryResources({
      accountID,
      token,
      runID: "123456789012",
      attempt: "123",
      request: api.fetch,
    })
    const cleanup = await resources.cleanup({ workerDeployed: true })
    expect(cleanup.failures).toEqual([{ resource: `worker:${name}`, message: "stop-and-purge-required" }])
    expect(cleanup.deleted).toEqual([])
    expect(api.calls.filter((call) => call.method === "DELETE")).toEqual([])
    const receipt = await cleanupCanaryResourceReceipt({
      accountID,
      token,
      receipt: { name, databaseID, r2BucketCreated: true, workerDeployed: true },
      request: api.fetch,
    })
    expect(receipt.failures).toEqual(cleanup.failures)
    expect(api.calls.filter((call) => call.method === "DELETE")).toEqual([])
    await expect(
      cleanupCanaryResourceReceipt({
        accountID,
        token,
        receipt: { name: "mongolgpt-runtime-dev", databaseID },
        request: api.fetch,
      }),
    ).rejects.toThrow("name")
  })

  test("cleanup waits for caller purge before deleting frontend and backend resources", async () => {
    const api = cloudflareMock()
    const resources = await createCanaryResources({
      accountID,
      token,
      runID: "123456789012",
      attempt: "123",
      request: api.fetch,
    })
    let purged = false

    const cleanup = await resources.cleanup({
      workerDeployed: true,
      containerApplicationID: containerID,
      purge: async () => {
        purged = true
      },
    })

    expect(cleanup.deleted).toEqual([`worker:${name}`, `container:${containerID}`, `r2:${name}`, `d1:${databaseID}`])
    expect(purged).toBe(true)
    expect(api.calls.map((call) => [call.method, call.path]).slice(-8)).toEqual([
      ["GET", `/accounts/${accountID}/workers/scripts/${name}/settings`],
      ["GET", `/accounts/${accountID}/containers/applications/${containerID}`],
      ["DELETE", `/accounts/${accountID}/workers/scripts/${name}`],
      ["DELETE", `/accounts/${accountID}/containers/applications/${containerID}`],
      ["GET", `/accounts/${accountID}/r2/buckets/${name}`],
      ["DELETE", `/accounts/${accountID}/r2/buckets/${name}`],
      ["GET", `/accounts/${accountID}/d1/database/${databaseID}`],
      ["DELETE", `/accounts/${accountID}/d1/database/${databaseID}`],
    ])
  })

  test("bounds response size and sanitizes Cloudflare errors", async () => {
    await expect(
      createCanaryResources({
        accountID,
        token,
        runID: "123456789012",
        attempt: "123",
        request: async () => new Response(JSON.stringify({ success: true, result: "x".repeat(70_000) })),
      }),
    ).rejects.toMatchObject({ message: "Cloudflare response exceeded 65536 bytes." })

    await expect(
      createCanaryResources({
        accountID,
        token,
        runID: "123456789012",
        attempt: "123",
        request: async () =>
          Response.json(
            {
              success: false,
              errors: [{ code: 10000, message: `Bearer ${token} ${"a".repeat(64)}` }],
            },
            { status: 500 },
          ),
      }),
    ).rejects.toMatchObject({ message: expect.not.stringContaining(token) })
  })
})

describe("canary wrangler config", () => {
  test("generates a dev-only Worker config bound only to fresh canary D1/R2 resources", async () => {
    const root = fileURLToPath(new URL("../", import.meta.url))
    const config = createCanaryConfig({
      accountID,
      resources: { name, databaseID },
      root,
      version: "0.1.1",
    })

    expect(config.name).toBe(name)
    expect(config.main).toBe(join(root, "test", "fixtures", "cloudflare-canary.ts"))
    expect(config.containers).toEqual([
      {
        name,
        class_name: "CanarySandbox",
        image: join(root, "Dockerfile"),
        instance_type: "basic",
        max_instances: 1,
      },
    ])
    expect(config.durable_objects.bindings).toEqual([{ name: "Sandbox", class_name: "CanarySandbox" }])
    expect(config.d1_databases).toEqual([
      { binding: "HISTORY", database_name: name, database_id: databaseID, migrations_dir: join(root, "migrations") },
    ])
    expect(config.r2_buckets).toEqual([{ binding: "RUNTIME_BACKUPS", bucket_name: name }])
    expect(config.services).toEqual([
      { binding: "RuntimeAccountCleanup", service: name, entrypoint: "RuntimeAccountCleanup" },
    ])
    expect(config.workers_dev).toBe(true)
    expect(config).not.toHaveProperty("routes")
    expect(config).not.toHaveProperty("custom_domain")
    expect(config.vars).toEqual({
      STAGE: "dev",
      MONGOLGPT_CLOUD_HISTORY: "true",
      MONGOLGPT_RUNTIME_ACCOUNT_CLEANUP: "true",
      CANARY_RUN_ID: name,
      MONGOLGPT_APP_ORIGIN: "https://canary.invalid",
      MONGOLGPT_CONSOLE_URL: "https://canary.invalid",
      MONGOLGPT_RUNTIME_VERSION: "0.1.1",
    })
    expect(config.ratelimits.map((limit) => limit.simple)).toEqual([
      { limit: 60, period: 10 },
      { limit: 300, period: 60 },
    ])
    const namespaceIDs = config.ratelimits.map((limit) => limit.namespace_id)
    expect(namespaceIDs).toHaveLength(2)
    expect(namespaceIDs[0]).not.toBe(namespaceIDs[1])
    for (const namespaceID of namespaceIDs) {
      expect(namespaceID).toMatch(/^[1-9][0-9]*$/)
      expect(["206071801", "206071802", "206071811", "206071812"]).not.toContain(namespaceID)
    }
    expect(config.secrets.required).toEqual([
      "MONGOLGPT_RUNTIME_SECRET",
      "MONGOLGPT_RUNTIME_AUTH_SECRET",
      "MONGOLGPT_RUNTIME_BACKUP_KEYS",
      "CANARY_ADMIN_TOKEN",
    ])
    expect([config.main, config.containers[0]!.image, config.d1_databases[0]!.migrations_dir].every(isAbsolute)).toBe(
      true,
    )
    expect(await Bun.file(new URL("./fixtures/cloudflare-canary.ts", import.meta.url)).text()).toContain(
      "export { ContainerProxy }",
    )
  })
})

type MockOptions = {
  workerExists?: boolean
  bucketExists?: boolean
  databaseExists?: boolean
  failR2Create?: boolean
  failR2Delete?: boolean
  cleanupWorkerName?: string
  cleanupBucketName?: string
  cleanupDatabaseName?: string
  cleanupContainerName?: string
  cleanupContainerNamespaceID?: string
  discoverContainer?: boolean
  discoverContainerDuplicates?: boolean
  discoverContainerInvalidShape?: boolean
  invalidD1List?: boolean
  containerDelete204?: boolean
}

function cloudflareMock(options: MockOptions = {}) {
  const calls: Array<{
    method: string
    path: string
    authorization: string | null
    body: string
    signal: unknown
    redirect: RequestRedirect | undefined
  }> = []
  const fetch: CanaryRequest = async (input, init = {}) => {
    const url = new URL(input)
    const method = init.method ?? "GET"
    calls.push({
      method,
      path: `${url.pathname.replace(/^\/client\/v4/, "")}${url.search}`,
      authorization: new Headers(init.headers).get("authorization"),
      body: typeof init.body === "string" ? init.body : "",
      signal: init.signal,
      redirect: init.redirect,
    })

    if (method === "GET" && url.pathname.endsWith(`/workers/scripts/${name}/settings`)) {
      if (
        calls.filter((call) => call.path.endsWith(`/workers/scripts/${name}/settings`)).length === 1 &&
        !options.workerExists
      ) {
        return missing()
      }
      return cloudflare(workerSettings(options.cleanupWorkerName))
    }
    if (method === "GET" && url.pathname.endsWith(`/r2/buckets/${name}`)) {
      if (calls.filter((call) => call.path.endsWith(`/r2/buckets/${name}`)).length === 1 && !options.bucketExists)
        return missing()
      return cloudflare({ name: options.cleanupBucketName ?? name })
    }
    if (method === "GET" && url.pathname.endsWith("/d1/database")) {
      if (options.invalidD1List) return cloudflare({ databases: [] })
      return cloudflare(options.databaseExists ? [{ uuid: databaseID, name }] : [])
    }
    if (method === "GET" && url.pathname.endsWith("/workers/subdomain")) {
      return cloudflare({ subdomain: "example-subdomain" })
    }
    if (method === "POST" && url.pathname.endsWith("/d1/database")) {
      return cloudflare({ uuid: databaseID, name })
    }
    if (method === "POST" && url.pathname.endsWith("/r2/buckets")) {
      if (options.failR2Create) {
        return Response.json(
          { success: false, errors: [{ code: 10013, message: `lost response ${token}` }] },
          { status: 503 },
        )
      }
      return cloudflare({ name })
    }
    if (method === "GET" && url.pathname.endsWith(`/d1/database/${databaseID}`)) {
      return cloudflare({ uuid: databaseID, name: options.cleanupDatabaseName ?? name })
    }
    if (method === "GET" && url.pathname.endsWith("/containers/applications")) {
      if (options.discoverContainerInvalidShape) return Response.json({ applications: "invalid" })
      if (options.discoverContainerDuplicates) {
        return Response.json([
          { id: containerID, name, durable_objects: { namespace_id: namespaceID } },
          { id: "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee", name, durable_objects: { namespace_id: namespaceID } },
        ])
      }
      if (!options.discoverContainer) return Response.json([])
      return Response.json([
        {
          id: containerID,
          name,
          durable_objects: { namespace_id: namespaceID },
        },
      ])
    }
    if (method === "GET" && url.pathname.endsWith(`/containers/applications/${containerID}`)) {
      const appName = options.cleanupContainerName ?? name
      return Response.json({
        id: containerID,
        name: appName,
        durable_objects: { namespace_id: options.cleanupContainerNamespaceID ?? namespaceID },
        configuration: { image: "registry.example/canary" },
      })
    }
    if (
      method === "DELETE" &&
      url.pathname.endsWith(`/containers/applications/${containerID}`) &&
      options.containerDelete204
    ) {
      return new Response(null, { status: 204 })
    }
    if (method === "DELETE" && url.pathname.endsWith(`/r2/buckets/${name}`) && options.failR2Delete)
      return Response.json({ success: false, errors: [{ code: 100, message: "Bucket is not empty" }] }, { status: 409 })
    if (method === "DELETE") return cloudflare({})
    throw new Error(`unexpected ${method} ${url.pathname}${url.search}`)
  }
  return { calls, fetch }
}

function cloudflare(result: unknown, status = 200) {
  return Response.json({ success: true, result }, { status })
}

function missing() {
  return Response.json({ success: false, errors: [{ code: 10007, message: "not found" }] }, { status: 404 })
}

function workerSettings(historyID = databaseID) {
  return {
    bindings: [
      { type: "d1", name: "HISTORY", id: historyID },
      { type: "r2_bucket", name: "RUNTIME_BACKUPS", bucket_name: name },
      { type: "durable_object_namespace", name: "Sandbox", class_name: "CanarySandbox", namespace_id: namespaceID },
    ],
  }
}
