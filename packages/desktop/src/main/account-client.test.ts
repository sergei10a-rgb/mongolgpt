import { describe, expect, test } from "bun:test"

import { createDesktopAccountClient } from "./account-client"

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })

const server = async () => ({ url: "http://127.0.0.1:4096", username: "mongolgpt", password: "secret" })

describe("desktop account client", () => {
  test("reads only the public active account over authenticated JSON", async () => {
    let authorization = ""
    const client = createDesktopAccountClient({
      server,
      accountServer: "https://dev.mgpt.mn",
      openExternal: async () => {},
      fetch: async (_input, init) => {
        authorization = new Headers(init?.headers).get("authorization") ?? ""
        return json({ id: "user-1", email: "user@example.com", url: "https://dev.mgpt.mn", activeOrgID: "org-1" })
      },
    })

    expect(await client.current()).toEqual({
      id: "user-1",
      email: "user@example.com",
      url: "https://dev.mgpt.mn",
      activeOrgID: "org-1",
    })
    expect(authorization).toBe(`Basic ${Buffer.from("mongolgpt:secret").toString("base64")}`)
  })

  test("opens browser login, polls to success, verifies account, and cleans the login record", async () => {
    const calls: string[] = []
    let polls = 0
    let opened = ""
    const client = createDesktopAccountClient({
      server,
      accountServer: "https://dev.mgpt.mn",
      openExternal: async (url) => {
        opened = url
      },
      sleep: async () => {},
      fetch: async (input, init) => {
        const url = input instanceof URL ? input : new URL(String(input))
        calls.push(`${init?.method ?? "GET"} ${url.pathname}`)
        if (url.pathname === "/experimental/account/login" && init?.method === "POST") {
          expect(JSON.parse(String(init.body))).toEqual({ server: "https://dev.mgpt.mn" })
          return json({ loginID: "login-1", url: "https://auth.dev.mgpt.mn/authorize" })
        }
        if (url.pathname === "/experimental/account/login/login-1" && init?.method !== "DELETE") {
          polls += 1
          return json(polls === 1 ? { _tag: "pending" } : { _tag: "success", email: "user@example.com" })
        }
        if (url.pathname === "/experimental/account") {
          return json({ id: "user-1", email: "user@example.com", url: "https://dev.mgpt.mn" })
        }
        return json(true)
      },
    })

    expect(await client.login()).toEqual({ id: "user-1", email: "user@example.com", url: "https://dev.mgpt.mn" })
    expect(opened).toBe("https://auth.dev.mgpt.mn/authorize")
    expect(calls).toContain("DELETE /experimental/account/login/login-1")
  })

  test("rejects an HTML fallback even when the sidecar returns HTTP 200", async () => {
    const client = createDesktopAccountClient({
      server,
      accountServer: "https://dev.mgpt.mn",
      openExternal: async () => {},
      fetch: async () =>
        new Response("<html>wrong route</html>", { status: 200, headers: { "content-type": "text/html" } }),
    })

    await expect(client.current()).rejects.toThrow("JSON-ийн оронд")
  })

  test("refuses to open a non-HTTPS remote authorization URL", async () => {
    let opened = false
    const client = createDesktopAccountClient({
      server,
      accountServer: "https://dev.mgpt.mn",
      openExternal: async () => {
        opened = true
      },
      fetch: async (input, init) => {
        const path = input instanceof URL ? input.pathname : new URL(String(input)).pathname
        if (path === "/experimental/account/login" && init?.method === "POST") {
          return json({ loginID: "login-1", url: "http://attacker.example/authorize" })
        }
        return json(true)
      },
    })

    await expect(client.login()).rejects.toThrow("HTTPS")
    expect(opened).toBe(false)
  })

  test("aborts an in-flight login request when the overall timeout expires", async () => {
    let aborted = false
    const client = createDesktopAccountClient({
      server,
      accountServer: "https://dev.mgpt.mn",
      loginTimeoutMs: 10,
      openExternal: async () => {},
      fetch: async (input, init) => {
        const path = input instanceof URL ? input.pathname : new URL(String(input)).pathname
        if (path === "/experimental/account/login" && init?.method === "POST") {
          return json({ loginID: "login-1", url: "https://auth.dev.mgpt.mn/authorize" })
        }
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              aborted = true
              reject(new DOMException("The operation was aborted", "AbortError"))
            },
            { once: true },
          )
        })
      },
    })

    await expect(client.login()).rejects.toThrow("Нэвтрэх хугацаа дууссан")
    expect(aborted).toBe(true)
  })

  test("bounds the cleanup request when login fails", async () => {
    let cleanupAborted = false
    const client = createDesktopAccountClient({
      server,
      accountServer: "https://dev.mgpt.mn",
      cancelTimeoutMs: 10,
      openExternal: async () => {},
      fetch: async (input, init) => {
        const url = input instanceof URL ? input : new URL(String(input))
        if (url.pathname === "/experimental/account/login" && init?.method === "POST") {
          return json({ loginID: "login-1", url: "https://auth.dev.mgpt.mn/authorize" })
        }
        if (url.pathname === "/experimental/account/login/login-1" && init?.method !== "DELETE") {
          return json({ _tag: "error", message: "Нэвтрэхийг цуцаллаа" })
        }
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              cleanupAborted = true
              reject(new DOMException("The operation was aborted", "AbortError"))
            },
            { once: true },
          )
        })
      },
    })

    await expect(client.login()).rejects.toThrow("Нэвтрэхийг цуцаллаа")
    expect(cleanupAborted).toBe(true)
  })
})
