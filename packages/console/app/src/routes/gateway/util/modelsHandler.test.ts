import { describe, expect, test } from "bun:test"
import { buildAuthenticatedModelsResponse, buildOptionsResponse } from "./modelsHandler"

const request = (authorization?: string) =>
  new Request("https://dev.mgpt.mn/gateway/v1/models", {
    headers: authorization ? { authorization } : undefined,
  })

describe("authenticated gateway model catalog", () => {
  test("advertises only the read-only authenticated CORS contract", async () => {
    const response = await buildOptionsResponse()

    expect(response.status).toBe(200)
    expect(response.headers.get("access-control-allow-methods")).toBe("GET, OPTIONS")
    expect(response.headers.get("access-control-allow-headers")).toContain("Authorization")
    expect(response.headers.get("access-control-allow-headers")).toContain("X-Org-ID")
    expect(response.headers.get("cache-control")).toBe("no-store")
  })

  test("does not reveal Free Auto or call account dependencies to an anonymous request", async () => {
    let authenticateCalls = 0
    const response = await buildAuthenticatedModelsResponse(request(), {
      authenticate: async () => {
        authenticateCalls++
        return "workspace-1"
      },
      disabled: async () => [],
      models: () => ["free-auto"],
    })

    expect(response.status).toBe(401)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("content-type")).toContain("application/json")
    expect(await response.text()).not.toContain("free-auto")
    expect(authenticateCalls).toBe(0)
  })

  test("fails closed for an invalid credential", async () => {
    let disabledCalls = 0
    const response = await buildAuthenticatedModelsResponse(request("Bearer invalid"), {
      authenticate: async () => undefined,
      disabled: async () => {
        disabledCalls++
        return []
      },
      models: () => ["free-auto"],
    })

    expect(response.status).toBe(401)
    expect(await response.text()).not.toContain("free-auto")
    expect(disabledCalls).toBe(0)
  })

  test("rejects a malformed authorization scheme before authentication", async () => {
    let authenticateCalls = 0
    const response = await buildAuthenticatedModelsResponse(request("Basic invalid"), {
      authenticate: async () => {
        authenticateCalls++
        return "workspace-1"
      },
      disabled: async () => [],
      models: () => ["free-auto"],
    })

    expect(response.status).toBe(401)
    expect(await response.text()).not.toContain("free-auto")
    expect(authenticateCalls).toBe(0)
  })

  test("returns the workspace-filtered catalog after authentication", async () => {
    const response = await buildAuthenticatedModelsResponse(request("Bearer valid"), {
      authenticate: async (_request, token) => (token === "valid" ? "workspace-1" : undefined),
      disabled: async (workspaceID) => (workspaceID === "workspace-1" ? ["disabled-model"] : []),
      models: () => ["free-auto", "disabled-model", "internal:global", "alpha-private"],
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("access-control-allow-origin")).toBe("*")
    expect(await response.json()).toMatchObject({
      object: "list",
      data: [{ id: "free-auto", object: "model", owned_by: "mongolgpt" }],
    })
  })

  test("hides every dynamic free model when the Free Auto policy is disabled", async () => {
    const response = await buildAuthenticatedModelsResponse(request("Bearer valid"), {
      authenticate: async () => "workspace-1",
      disabled: async () => ["free-auto"],
      models: () => ["free-auto", "big-pickle", "paid-model"],
      policyModelID: (id) => (id === "big-pickle" ? "free-auto" : id),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      data: [{ id: "paid-model", owned_by: "mongolgpt" }],
    })
  })
})
