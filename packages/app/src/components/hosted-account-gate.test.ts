import { afterEach, describe, expect, test } from "bun:test"
import {
  hostedAccountGateEnabled,
  hostedLoginUrl,
  hostedRuntimeTokenUrl,
  hostedSessionUrl,
  loadHostedSession,
} from "./hosted-account-gate"

const runtimeUrl = "https://runtime.dev.mgpt.mn/"
const publicUrl = "https://dev.mgpt.mn/"
const account = { id: "account_123", email: "user@example.com" }
const expiresAt = Date.now() + 60_000
const originalFetch = globalThis.fetch
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
const originalSessionStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage")

afterEach(() => {
  globalThis.fetch = originalFetch
  restoreGlobal("localStorage", originalLocalStorage)
  restoreGlobal("sessionStorage", originalSessionStorage)
})

describe("hosted account gate helpers", () => {
  test("builds the hosted auth endpoints", () => {
    expect(hostedRuntimeTokenUrl(publicUrl)).toBe("https://dev.mgpt.mn/auth/runtime-token")
    expect(hostedSessionUrl(runtimeUrl)).toBe("https://runtime.dev.mgpt.mn/auth/session")
  })

  test("builds a fixed internal callback login URL", () => {
    expect(hostedLoginUrl("https://dev.mgpt.mn")).toBe("https://dev.mgpt.mn/auth/authorize?continue=%2Fauth%2Fapp")
  })

  test("only enables the gate for hosted runtimes", () => {
    expect(hostedAccountGateEnabled("hosted", "https://runtime.dev.mgpt.mn")).toBe(true)
    expect(hostedAccountGateEnabled("local-bridge", "https://runtime.dev.mgpt.mn")).toBe(false)
    expect(hostedAccountGateEnabled(undefined, "http://127.0.0.1:4096")).toBe(false)
  })
})

describe("hosted auth exchange", () => {
  test("POSTs the capability and exchanges it with the runtime", async () => {
    const requests: Request[] = []
    setFetch(async (input, init) => {
      requests.push(new Request(input, init))
      if (requests.length === 1) {
        return json({ token: "secret-token", expiresAt, account })
      }
      return json({ authenticated: true, account: { id: account.id }, expiresAt })
    })

    await expect(loadHostedSession(runtimeUrl, publicUrl)).resolves.toEqual({
      authenticated: true,
      account,
      expiresAt,
    })
    expect(requests[0]?.url).toBe(hostedRuntimeTokenUrl(publicUrl))
    expect(requests[0]?.method).toBe("POST")
    expect(requests[0]?.headers.get("accept")).toBe("application/json")
    expect(requests[0]?.credentials).toBe("include")
    expect(requests[1]?.url).toBe(hostedSessionUrl(runtimeUrl))
    expect(requests[1]?.method).toBe("POST")
    expect(requests[1]?.headers.get("accept")).toBe("application/json")
    expect(requests[1]?.headers.get("authorization")).toBe("Bearer secret-token")
    expect(requests[1]?.credentials).toBe("include")
  })

  test("never uses browser storage for the capability", async () => {
    let storageReads = 0
    for (const name of ["localStorage", "sessionStorage"] as const) {
      Object.defineProperty(globalThis, name, {
        configurable: true,
        get() {
          storageReads += 1
          throw new Error(`${name} must not be read`)
        },
      })
    }
    setFetch(async (_, init) => {
      if (init?.headers && new Headers(init.headers).has("authorization")) {
        return json({ authenticated: true, account: { id: account.id }, expiresAt })
      }
      return json({ token: "secret-token", expiresAt, account })
    })

    await loadHostedSession(runtimeUrl, publicUrl)
    expect(storageReads).toBe(0)
  })

  test("fails closed for account mismatch, HTML, and error statuses", async () => {
    setFetch(async (input, init) => {
      const request = new Request(input, init)
      if (request.url === hostedRuntimeTokenUrl(publicUrl)) return json({ token: "secret-token", expiresAt, account })
      return json({ authenticated: true, account: { ...account, id: "different" }, expiresAt })
    })
    await expect(loadHostedSession(runtimeUrl, publicUrl)).rejects.toThrow("invalid")

    setFetch(async () => new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } }))
    await expect(loadHostedSession(runtimeUrl, publicUrl)).rejects.toThrow("JSON")

    setFetch(async () => new Response("error", { status: 500, headers: { "content-type": "text/html" } }))
    await expect(loadHostedSession(runtimeUrl, publicUrl)).rejects.toThrow("500")
  })

  test("treats only a console 401 as an anonymous session", async () => {
    setFetch(async () => json({ authenticated: false }, 401))
    await expect(loadHostedSession(runtimeUrl, publicUrl)).resolves.toEqual({ authenticated: false })

    let request = 0
    setFetch(async () => {
      request += 1
      if (request === 1) return json({ token: "secret-token", expiresAt, account })
      return json({ authenticated: false }, 401)
    })
    await expect(loadHostedSession(runtimeUrl, publicUrl)).rejects.toThrow("fresh capability")
  })
})

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function setFetch(
  fetcher: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>,
) {
  Object.defineProperty(globalThis, "fetch", { value: fetcher, configurable: true, writable: true })
}

function restoreGlobal(name: "localStorage" | "sessionStorage", descriptor: PropertyDescriptor | undefined) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor)
  else delete (globalThis as Record<string, unknown>)[name]
}
