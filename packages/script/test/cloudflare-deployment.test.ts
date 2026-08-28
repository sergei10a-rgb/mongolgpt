import { describe, expect, test } from "bun:test"
import { CloudflareDeploymentPreflightError, preflightCloudflareDeploymentAccess } from "../src/cloudflare-deployment"

const accountId = "a".repeat(32)
const domain = "mgpt.mn"

describe("Cloudflare deployment token preflight", () => {
  test("proves the token can read the selected zone and minimum hosted resources", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = []
    const responses = [
      response({ success: true, result: { status: "active" } }),
      response({ success: true, result: [{ id: "zone-id", name: domain, account: { id: accountId } }] }),
      response({ success: true, result: [] }),
      response({ success: true, result: { account_id: accountId } }),
      response({ success: true, result: [] }),
      response({ success: true, result: [] }),
      response({ success: true, result: { buckets: [] } }),
      response({ success: true, result: [] }),
    ]

    const result = await preflightCloudflareDeploymentAccess({
      accountId,
      domain: " MGPT.MN ",
      token: "deploy-token",
      fetcher: async (input, init) => {
        requests.push({
          url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
          authorization: new Headers(init?.headers).get("authorization"),
        })
        return responses.shift() ?? response({ success: false }, 500)
      },
    })

    expect(result).toEqual({ zoneId: "zone-id", domain })
    expect(requests.map((item) => item.url)).toEqual([
      "https://api.cloudflare.com/client/v4/user/tokens/verify",
      `https://api.cloudflare.com/client/v4/zones?name=mgpt.mn&account.id=${accountId}&per_page=2`,
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts`,
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/containers/me`,
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database?per_page=1`,
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces?per_page=1`,
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets?per_page=1`,
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/queues?per_page=1`,
    ])
    expect(requests.every((item) => item.authorization === "Bearer deploy-token")).toBe(true)
  })

  test("checks only Worker and Containers access for an isolated runtime deploy", async () => {
    const requests: string[] = []
    const responses = [
      response({ success: true, result: { status: "active" } }),
      response({ success: true, result: [{ id: "zone-id", name: domain, account: { id: accountId } }] }),
      response({ success: true, result: [] }),
      response({ success: true, result: { account_id: accountId } }),
    ]

    await preflightCloudflareDeploymentAccess({
      accountId,
      domain,
      token: "runtime-token",
      scope: "runtime-only",
      fetcher: async (input) => {
        requests.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
        return responses.shift() ?? response({ success: false }, 500)
      },
    })

    expect(requests).toEqual([
      "https://api.cloudflare.com/client/v4/user/tokens/verify",
      `https://api.cloudflare.com/client/v4/zones?name=mgpt.mn&account.id=${accountId}&per_page=2`,
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts`,
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/containers/me`,
    ])
  })

  test("checks hosted account resources without requiring Containers access", async () => {
    const requests: string[] = []
    const responses = [
      response({ success: true, result: { status: "active" } }),
      response({ success: true, result: [{ id: "zone-id", name: domain, account: { id: accountId } }] }),
      response({ success: true, result: [] }),
      response({ success: true, result: [] }),
      response({ success: true, result: [] }),
      response({ success: true, result: { buckets: [] } }),
      response({ success: true, result: [] }),
    ]

    await preflightCloudflareDeploymentAccess({
      accountId,
      domain,
      token: "hosted-token",
      scope: "hosted-only",
      fetcher: async (input) => {
        requests.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
        return responses.shift() ?? response({ success: false }, 500)
      },
    })

    expect(requests).toEqual([
      "https://api.cloudflare.com/client/v4/user/tokens/verify",
      `https://api.cloudflare.com/client/v4/zones?name=mgpt.mn&account.id=${accountId}&per_page=2`,
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts`,
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database?per_page=1`,
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces?per_page=1`,
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets?per_page=1`,
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/queues?per_page=1`,
    ])
    expect(requests.some((url) => url.includes("/containers/"))).toBe(false)
  })

  test("does not require unrelated backend or Containers access for a static Worker deploy", async () => {
    const requests: string[] = []
    const responses = [
      response({ success: true, result: { status: "active" } }),
      response({ success: true, result: [{ id: "zone-id", name: domain, account: { id: accountId } }] }),
      response({ success: true, result: [] }),
    ]

    await preflightCloudflareDeploymentAccess({
      accountId,
      domain,
      token: "worker-token",
      scope: "worker-only",
      fetcher: async (input) => {
        requests.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
        return responses.shift() ?? response({ success: false }, 500)
      },
    })

    expect(requests).toEqual([
      "https://api.cloudflare.com/client/v4/user/tokens/verify",
      `https://api.cloudflare.com/client/v4/zones?name=mgpt.mn&account.id=${accountId}&per_page=2`,
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts`,
    ])
  })

  test("rejects invalid inputs and an inactive token before resource probes", async () => {
    await expect(
      preflightCloudflareDeploymentAccess({
        accountId: "wrong",
        token: "token",
        domain,
        fetcher: async () => response({}),
      }),
    ).rejects.toThrow("32 тэмдэгт")
    await expect(
      preflightCloudflareDeploymentAccess({ accountId, token: " ", domain, fetcher: async () => response({}) }),
    ).rejects.toThrow("token дутуу")
    await expect(
      preflightCloudflareDeploymentAccess({
        accountId,
        token: "token",
        domain: "https://mgpt.mn",
        fetcher: async () => response({}),
      }),
    ).rejects.toThrow("domain хүчинтэй биш")
    await expect(
      preflightCloudflareDeploymentAccess({
        accountId,
        token: "token",
        domain,
        fetcher: async () => response({ success: true, result: { status: "disabled" } }),
      }),
    ).rejects.toThrow("идэвхтэй биш")
  })

  test("requires exactly one matching zone in the configured account", async () => {
    const missing = [response({ success: true, result: { status: "active" } }), response({ success: true, result: [] })]
    await expect(
      preflightCloudflareDeploymentAccess({
        accountId,
        token: "token",
        domain,
        fetcher: async () => missing.shift()!,
      }),
    ).rejects.toThrow("Zone Read")

    const mismatch = [
      response({ success: true, result: { status: "active" } }),
      response({ success: true, result: [{ id: "zone-id", name: domain, account: { id: "b".repeat(32) } }] }),
    ]
    await expect(
      preflightCloudflareDeploymentAccess({
        accountId,
        token: "token",
        domain,
        fetcher: async () => mismatch.shift()!,
      }),
    ).rejects.toThrow("тохирохгүй")
  })

  test("reports the exact unreadable service without leaking the token", async () => {
    const responses = [
      response({ success: true, result: { status: "active" } }),
      response({ success: true, result: [{ id: "zone-id", name: domain, account: { id: accountId } }] }),
      response({ success: false, errors: [{ message: "must-not-surface" }] }, 403),
    ]
    const error = await rejection(
      preflightCloudflareDeploymentAccess({
        accountId,
        token: "must-not-leak",
        domain,
        fetcher: async () => responses.shift()!,
      }),
    )

    expect(error).toBeInstanceOf(CloudflareDeploymentPreflightError)
    expect(String(error)).toContain("Workers Scripts")
    expect(String(error)).toContain("HTTP 403")
    expect(String(error)).not.toContain("must-not-leak")
    expect(String(error)).not.toContain("must-not-surface")
  })

  test("fails before build when the deploy token cannot access Containers", async () => {
    const responses = [
      response({ success: true, result: { status: "active" } }),
      response({ success: true, result: [{ id: "zone-id", name: domain, account: { id: accountId } }] }),
      response({ success: true, result: [] }),
      response({ success: false, errors: [{ message: "container-details-must-not-surface" }] }, 403),
    ]
    const error = await rejection(
      preflightCloudflareDeploymentAccess({
        accountId,
        token: "container-token-must-not-leak",
        domain,
        scope: "runtime-only",
        fetcher: async () => responses.shift()!,
      }),
    )

    expect(error).toBeInstanceOf(CloudflareDeploymentPreflightError)
    expect(String(error)).toContain("Containers")
    expect(String(error)).toContain("HTTP 403")
    expect(String(error)).toContain("Workers Paid plan")
    expect(String(error)).toContain("Containers Read/Write")
    expect(String(error)).not.toContain("container-token-must-not-leak")
    expect(String(error)).not.toContain("container-details-must-not-surface")
  })

  test("reports a hosted account resource denial without probing Containers or leaking details", async () => {
    const requests: string[] = []
    const responses = [
      response({ success: true, result: { status: "active" } }),
      response({ success: true, result: [{ id: "zone-id", name: domain, account: { id: accountId } }] }),
      response({ success: true, result: [] }),
      response({ success: false, errors: [{ message: "d1-details-must-not-surface" }] }, 403),
    ]
    const error = await rejection(
      preflightCloudflareDeploymentAccess({
        accountId,
        token: "hosted-token-must-not-leak",
        domain,
        scope: "hosted-only",
        fetcher: async (input) => {
          requests.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
          return responses.shift()!
        },
      }),
    )

    expect(error).toBeInstanceOf(CloudflareDeploymentPreflightError)
    expect(String(error)).toContain("D1")
    expect(String(error)).toContain("HTTP 403")
    expect(String(error)).not.toContain("hosted-token-must-not-leak")
    expect(String(error)).not.toContain("d1-details-must-not-surface")
    expect(requests.some((url) => url.includes("/containers/"))).toBe(false)
  })

  test("validates the R2 response envelope instead of accepting an unrelated list", async () => {
    const responses = [
      response({ success: true, result: { status: "active" } }),
      response({ success: true, result: [{ id: "zone-id", name: domain, account: { id: accountId } }] }),
      response({ success: true, result: [] }),
      response({ success: true, result: { account_id: accountId } }),
      response({ success: true, result: [] }),
      response({ success: true, result: [] }),
      response({ success: true, result: [] }),
    ]

    await expect(
      preflightCloudflareDeploymentAccess({
        accountId,
        token: "token",
        domain,
        fetcher: async () => responses.shift()!,
      }),
    ).rejects.toThrow("Workers R2 Storage")
  })

  test("rejects malformed, oversized, and unreachable Cloudflare responses", async () => {
    await expect(
      preflightCloudflareDeploymentAccess({
        accountId,
        token: "token",
        domain,
        fetcher: async () => new Response("not-json", { headers: { "content-type": "text/plain" } }),
      }),
    ).rejects.toThrow("JSON бус")
    await expect(
      preflightCloudflareDeploymentAccess({
        accountId,
        token: "token",
        domain,
        fetcher: async () => new Response("{}", { headers: { "content-length": String(33 * 1024) } }),
      }),
    ).rejects.toThrow("хэт том")
    await expect(
      preflightCloudflareDeploymentAccess({
        accountId,
        token: "token",
        domain,
        fetcher: async () => Promise.reject(new Error("network failed with token")),
      }),
    ).rejects.toThrow("холбогдож чадсангүй")
  })
})

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  })
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error("Promise амжилтгүй болох ёстой байсан.")
}
