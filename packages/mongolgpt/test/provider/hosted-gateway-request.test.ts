import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { HostedCredential } from "@mongolgpt/core/hosted-credential"
import { hostedGatewayRequest } from "../../src/provider/hosted-gateway-request"

const consoleUrl = "https://dev.mgpt.mn"
const gatewayUrl = `${consoleUrl}/gateway/v1/chat/completions`

let previousRuntimeMode: string | undefined
let previousApiKey: string | undefined

beforeEach(() => {
  previousRuntimeMode = process.env.MONGOLGPT_RUNTIME_MODE
  previousApiKey = process.env.MONGOLGPT_API_KEY
  process.env.MONGOLGPT_RUNTIME_MODE = "hosted"
  process.env.MONGOLGPT_API_KEY = HostedCredential.Placeholder
  HostedCredential.clear()
})

afterEach(() => {
  HostedCredential.clear()
  if (previousRuntimeMode === undefined) delete process.env.MONGOLGPT_RUNTIME_MODE
  else process.env.MONGOLGPT_RUNTIME_MODE = previousRuntimeMode
  if (previousApiKey === undefined) delete process.env.MONGOLGPT_API_KEY
  else process.env.MONGOLGPT_API_KEY = previousApiKey
})

describe("hostedGatewayRequest", () => {
  test("uses a fresh hosted capability on consecutive requests across a cached SDK boundary", () => {
    const first = capability({ exp: epochSeconds() + 90, marker: "first" })
    const second = capability({ exp: epochSeconds() + 90, marker: "second" })

    expect(HostedCredential.capture(first)).toBe(true)
    const firstRequest = hostedGatewayRequest(gatewayUrl, undefined, consoleUrl)
    expect(new Headers(firstRequest.headers).get("authorization")).toBe(`Bearer ${first}`)

    expect(HostedCredential.capture(second)).toBe(true)
    const secondRequest = hostedGatewayRequest(gatewayUrl, undefined, consoleUrl)
    expect(new Headers(secondRequest.headers).get("authorization")).toBe(`Bearer ${second}`)
  })

  test("rejects missing and expired hosted capabilities", () => {
    expect(() => hostedGatewayRequest(gatewayUrl, undefined, consoleUrl)).toThrow(
      "Cloud нэвтрэх сессийн хугацаа дууссан",
    )

    const expired = capability({ exp: epochSeconds() - 1, marker: "expired" })
    expect(HostedCredential.capture(expired)).toBe(false)
    expect(() => hostedGatewayRequest(gatewayUrl, undefined, consoleUrl)).toThrow(
      "Cloud нэвтрэх сессийн хугацаа дууссан",
    )
  })

  test("rejects destinations outside the current HTTPS console gateway", () => {
    const token = capability({ exp: epochSeconds() + 90 })
    expect(HostedCredential.capture(token)).toBe(true)

    expect(() => hostedGatewayRequest(gatewayUrl, undefined, "http://dev.mgpt.mn")).toThrow("Cloud нэвтрэх мэдээллийг")

    for (const input of [
      "http://dev.mgpt.mn/gateway/v1/chat/completions",
      "https://other.mgpt.mn/gateway/v1/chat/completions",
      "https://user:pass@dev.mgpt.mn/gateway/v1/chat/completions",
      "https://dev.mgpt.mn/v1/chat/completions",
      "https://dev.mgpt.mn/gateway/v2/chat/completions",
      "https://dev.mgpt.mn/gateway/v1/chat/completions#fragment",
    ]) {
      expect(() => hostedGatewayRequest(input, undefined, consoleUrl)).toThrow("Cloud нэвтрэх мэдээллийг")
    }
  })

  test("copies Request and init headers without mutating either source", () => {
    const token = capability({ exp: epochSeconds() + 90 })
    expect(HostedCredential.capture(token)).toBe(true)

    const requestHeaders = new Headers({
      authorization: "Bearer stale-request",
      "x-api-key": "stale-request-key",
      "x-request-only": "request",
      "x-shared": "request",
    })
    const initHeaders = new Headers({
      authorization: "Bearer stale-init",
      "x-init-only": "init",
      "x-shared": "init",
    })
    const request = new Request(gatewayUrl, { headers: requestHeaders })

    const result = hostedGatewayRequest(request, { headers: initHeaders, method: "POST" }, consoleUrl)
    const headers = new Headers(result.headers)

    expect(result.method).toBe("POST")
    expect(result.redirect).toBe("error")
    expect(headers.get("authorization")).toBe(`Bearer ${token}`)
    expect(headers.get("x-api-key")).toBe(token)
    expect(headers.get("x-request-only")).toBe("request")
    expect(headers.get("x-init-only")).toBe("init")
    expect(headers.get("x-shared")).toBe("init")

    expect(request.headers.get("authorization")).toBe("Bearer stale-request")
    expect(request.headers.get("x-api-key")).toBe("stale-request-key")
    expect(initHeaders.get("authorization")).toBe("Bearer stale-init")
    expect(initHeaders.get("x-shared")).toBe("init")
  })

  test("replaces model-format API key headers only when they are already present", () => {
    const token = capability({ exp: epochSeconds() + 90 })
    expect(HostedCredential.capture(token)).toBe(true)

    const withoutModelKeys = hostedGatewayRequest(
      gatewayUrl,
      { headers: { "content-type": "application/json" } },
      consoleUrl,
    )
    const withoutHeaders = new Headers(withoutModelKeys.headers)
    expect(withoutHeaders.get("authorization")).toBe(`Bearer ${token}`)
    expect(withoutHeaders.has("x-api-key")).toBe(false)
    expect(withoutHeaders.has("x-goog-api-key")).toBe(false)

    const withModelKeys = hostedGatewayRequest(
      gatewayUrl,
      { headers: { "x-api-key": "old-openai-compatible", "x-goog-api-key": "old-google" } },
      consoleUrl,
    )
    const withHeaders = new Headers(withModelKeys.headers)
    expect(withHeaders.get("x-api-key")).toBe(token)
    expect(withHeaders.get("x-goog-api-key")).toBe(token)
  })
})

function capability(payload: { exp: number; marker?: string }) {
  return [
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "synthetic-signature",
  ].join(".")
}

function epochSeconds() {
  return Math.floor(Date.now() / 1000)
}
