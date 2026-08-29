import { describe, expect, test } from "bun:test"

import { createBrowserCallbackServer } from "../../src/account/account"

describe("browser OAuth callback", () => {
  test("ignores a wrong-state error and still accepts the matching callback", async () => {
    const callback = await createBrowserCallbackServer()
    callback.setState("expected-state")

    try {
      const rejected = new URL(callback.redirect)
      rejected.searchParams.set("error", "access_denied")
      rejected.searchParams.set("state", "wrong-state")
      expect((await fetch(rejected)).status).toBe(400)

      const accepted = new URL(callback.redirect)
      accepted.searchParams.set("code", "authorization-code")
      accepted.searchParams.set("state", "expected-state")
      expect((await fetch(accepted)).status).toBe(200)
      expect(await callback.code).toBe("authorization-code")
    } finally {
      await callback.close()
    }
  })

  test("rejects an error callback only when its state matches", async () => {
    const callback = await createBrowserCallbackServer()
    callback.setState("expected-state")

    try {
      const rejected = new URL(callback.redirect)
      rejected.searchParams.set("error_description", "Хэрэглэгч зөвшөөрсөнгүй")
      rejected.searchParams.set("state", "expected-state")
      const code = callback.code.catch((error: unknown) => error)
      expect((await fetch(rejected)).status).toBe(400)
      const result = await code
      expect(result).toBeInstanceOf(Error)
      if (!(result instanceof Error)) throw new Error("Expected OAuth callback error")
      expect(result.message).toBe("Хэрэглэгч зөвшөөрсөнгүй")
    } finally {
      await callback.close()
    }
  })

  test("reports a server error callback even when the provider omits state", async () => {
    const callback = await createBrowserCallbackServer()
    callback.setState("expected-state")

    try {
      const rejected = new URL(callback.redirect)
      rejected.searchParams.set("error", "server_error")
      rejected.searchParams.set("error_description", "Failed query: begin")
      const code = callback.code.catch((error: unknown) => error)
      const response = await fetch(rejected)

      expect(response.status).toBe(400)
      expect(await response.text()).toContain("Failed query: begin")
      const result = await code
      expect(result).toBeInstanceOf(Error)
      if (!(result instanceof Error)) throw new Error("Expected OAuth callback error")
      expect(result.message).toBe("Failed query: begin")
    } finally {
      await callback.close()
    }
  })
})
