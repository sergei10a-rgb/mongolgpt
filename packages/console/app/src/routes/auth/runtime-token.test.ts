import { describe, expect, test } from "bun:test"
import { verifyRuntimeCapability } from "@mongolgpt/runtime-auth"
import { runtimeTokenPreflight, runtimeTokenRequest } from "./runtime-token-handler"

const appUrl = "https://app.dev.mgpt.mn"
const runtimeUrl = "https://runtime.dev.mgpt.mn"
const secret = "runtime-auth-secret-with-at-least-thirty-two-characters"
const now = 1_700_000_000
const account = { id: "acc_123", email: "user@mgpt.mn", authVersion: 4 }

function request(method = "POST", origin = appUrl, workspaceID?: string) {
  return new Request("https://dev.mgpt.mn/auth/runtime-token", {
    method,
    headers: {
      ...(origin ? { origin } : {}),
      ...(workspaceID ? { "x-org-id": workspaceID } : {}),
    },
  })
}

function handler(input: {
  current?: string
  accounts?: Record<string, typeof account>
  suspended?: boolean
  runtime?: string
  workspaceID?: string
  workspaces?: readonly { id: string; name: string }[]
}) {
  return runtimeTokenRequest(request("POST", appUrl, input.workspaceID), {
    appUrl,
    runtimeUrl: input.runtime ?? runtimeUrl,
    secret,
    now: () => now,
    session: async () => ({
      data: { current: input.current, account: input.accounts },
      suspended: input.suspended ?? false,
    }),
    workspaces: async () => input.workspaces ?? [{ id: "wrk_primary", name: "Үндсэн баг" }],
  })
}

describe("hosted runtime capability route", () => {
  test("issues a short audience-bound capability for the current account", async () => {
    const response = await handler({ current: account.id, accounts: { [account.id]: account } })

    expect(response.status).toBe(200)
    expect(response.headers.get("access-control-allow-origin")).toBe(appUrl)
    expect(response.headers.get("access-control-allow-credentials")).toBe("true")
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("vary")).toBe("Origin")
    const body: unknown = await response.json()
    if (!runtimeTokenBody(body)) throw new Error("Runtime token response shape is invalid")
    expect(body.expiresAt).toBe((now + 90) * 1000)
    expect(body.account).toEqual({ id: account.id, email: account.email })
    expect(body.workspace).toEqual({ id: "wrk_primary", name: "Үндсэн баг" })
    expect(await verifyRuntimeCapability({ token: body.token, audience: runtimeUrl, secret, now })).toMatchObject({
      sub: account.id,
      workspaceID: "wrk_primary",
      authVersion: 4,
      exp: now + 90,
    })
  })

  test("rejects missing or foreign origins without reflecting CORS", async () => {
    for (const origin of ["", "https://attacker.example"]) {
      const response = await runtimeTokenRequest(request("POST", origin), {
        appUrl,
        runtimeUrl,
        secret,
        session: async () => ({ data: {}, suspended: false }),
        workspaces: async () => [],
      })
      expect(response.status).toBe(403)
      expect(response.headers.get("access-control-allow-origin")).toBeNull()
    }
  })

  test("returns a strict credentialed preflight only to the hosted app", () => {
    const response = runtimeTokenPreflight(request("OPTIONS"), appUrl)
    expect(response.status).toBe(204)
    expect(response.headers.get("access-control-allow-origin")).toBe(appUrl)
    expect(response.headers.get("access-control-allow-credentials")).toBe("true")
    expect(response.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS")
    expect(response.headers.get("access-control-allow-headers")).toBe("Content-Type, X-Org-ID")
  })

  test("distinguishes anonymous, suspended, and another active current account", async () => {
    expect((await handler({})).status).toBe(401)
    expect((await handler({ suspended: true })).status).toBe(423)
    expect(
      (
        await handler({
          current: account.id,
          accounts: { [account.id]: account },
          suspended: true,
        })
      ).status,
    ).toBe(200)
  })

  test("fails closed when the runtime audience is not a clean HTTPS origin", async () => {
    const response = await handler({
      current: account.id,
      accounts: { [account.id]: account },
      runtime: "https://runtime.dev.mgpt.mn/path",
    })
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      error: "runtime_not_configured",
      message: "MongolGPT runtime серверийн хаяг тохируулагдаагүй байна.",
    })
  })

  test("requires an explicit server-verified workspace when the account has multiple memberships", async () => {
    const workspaces = [
      { id: "wrk_first", name: "Нэгдүгээр баг" },
      { id: "wrk_second", name: "Хоёрдугаар баг" },
    ]
    const selection = await handler({ current: account.id, accounts: { [account.id]: account }, workspaces })
    expect(selection.status).toBe(409)
    expect(await selection.json()).toMatchObject({
      error: "workspace_required",
      account: { id: account.id },
      workspaces,
    })

    const selected = await handler({
      current: account.id,
      accounts: { [account.id]: account },
      workspaces,
      workspaceID: "wrk_second",
    })
    expect(selected.status).toBe(200)
    const body: unknown = await selected.json()
    if (!runtimeTokenBody(body)) throw new Error("Runtime token response shape is invalid")
    expect(body.workspace).toEqual(workspaces[1])
    expect(await verifyRuntimeCapability({ token: body.token, audience: runtimeUrl, secret, now })).toMatchObject({
      workspaceID: "wrk_second",
    })
  })

  test("rejects malformed and unauthorized workspace selections", async () => {
    const base = {
      current: account.id,
      accounts: { [account.id]: account },
      workspaces: [{ id: "wrk_primary", name: "Үндсэн баг" }],
    }
    expect((await handler({ ...base, workspaceID: "not-a-workspace" })).status).toBe(400)
    const forbidden = await handler({ ...base, workspaceID: "wrk_foreign" })
    expect(forbidden.status).toBe(403)
    expect(await forbidden.json()).toMatchObject({ error: "workspace_forbidden" })
  })
})

function runtimeTokenBody(value: unknown): value is {
  token: string
  expiresAt: number
  account: { id: string; email: string }
  workspace: { id: string; name: string }
} {
  return (
    record(value) &&
    typeof value.token === "string" &&
    typeof value.expiresAt === "number" &&
    record(value.account) &&
    typeof value.account.id === "string" &&
    typeof value.account.email === "string" &&
    record(value.workspace) &&
    typeof value.workspace.id === "string" &&
    typeof value.workspace.name === "string"
  )
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
