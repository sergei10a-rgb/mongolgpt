import { describe, expect, test } from "bun:test"
import { authFromToken, authTokenFromCredentials, createSdkForServer, createServerRequest, isHostedServer } from "./server"

describe("authFromToken", () => {
  test("decodes basic auth credentials from auth_token", () => {
    expect(authFromToken(btoa("kit:secret"))).toEqual({ username: "kit", password: "secret" })
  })

  test("defaults blank username to mongolgpt", () => {
    expect(authFromToken(btoa(":secret"))).toEqual({ username: "mongolgpt", password: "secret" })
  })

  test("ignores malformed tokens", () => {
    expect(authFromToken("not base64")).toBeUndefined()
    expect(authFromToken(btoa("missing-separator"))).toBeUndefined()
  })
})

describe("authTokenFromCredentials", () => {
  test("encodes credentials with the default username", () => {
    expect(authTokenFromCredentials({ password: "secret" })).toBe(btoa("mongolgpt:secret"))
  })
})

describe("hosted credentials", () => {
  test("identifies hosted and loopback servers", () => {
    expect(isHostedServer("https://runtime.dev.mgpt.mn")).toBe(true)
    expect(isHostedServer("http://127.0.0.1:4096")).toBe(false)
  })

  test("includes cookies for hosted direct requests by default", async () => {
    let request: Request | undefined
    const fetcher = async (input: RequestInfo | URL) => {
      request = input instanceof Request ? input : new Request(input)
      return Response.json({ ok: true })
    }

    await createServerRequest({ server: { url: "https://runtime.dev.mgpt.mn" }, fetch: fetcher })("/auth/session")
    expect(request?.credentials).toBe("include")
  })

  test("respects explicit caller credentials", async () => {
    let request: Request | undefined
    const fetcher = async (input: RequestInfo | URL) => {
      request = input instanceof Request ? input : new Request(input)
      return Response.json({ ok: true })
    }

    await createServerRequest({ server: { url: "https://runtime.dev.mgpt.mn" }, fetch: fetcher })("/x", {
      credentials: "omit",
    })
    expect(request?.credentials).toBe("omit")
  })

  test("includes cookies for hosted SDK requests by default", async () => {
    let request: Request | undefined
    const fetcher = (async (input: RequestInfo | URL) => {
      request = input instanceof Request ? input : new Request(input)
      return Response.json({ healthy: true })
    }) as typeof fetch

    const sdk = createSdkForServer({ server: { url: "https://runtime.dev.mgpt.mn" }, fetch: fetcher })
    await sdk.global.health()
    expect(request?.credentials).toBe("include")
  })
})
