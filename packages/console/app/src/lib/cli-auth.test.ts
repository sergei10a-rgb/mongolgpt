import { describe, expect, test } from "bun:test"
import { mock } from "bun:test"
import { issueRuntimeCapability, verifyRuntimeCapability } from "@mongolgpt/runtime-auth"

await mock.module("@mongolgpt/console-resource", () => ({
  Resource: {
    AUTH_API_URL: { value: "https://auth.test" },
    MongolGPTRuntimeAuthSecret: { value: "runtime-auth-secret-with-at-least-thirty-two-characters" },
  },
}))
await mock.module("@mongolgpt/console-core/account-access.js", () => ({
  AccountAccess: {
    verify: async (input: { authVersion: number }) => ({ allowed: input.authVersion !== 9 }),
  },
}))

const { selectGatewayWorkspace, verifyGatewayAccount } = await import("./cli-auth")

const secret = "runtime-auth-secret-with-at-least-thirty-two-characters"
const request = (token: string) =>
  new Request("https://console.mgpt.mn/gateway/v1/chat/completions", {
    headers: { authorization: `Bearer ${token}` },
  })

describe("Gateway workspace authentication contract", () => {
  test("accepts a valid console-audience runtime capability", async () => {
    const token = await issueRuntimeCapability({
      accountID: "acc_runtime_test",
      authVersion: 1,
      audience: "https://console.mgpt.mn",
      secret,
    })
    const verified = await verifyRuntimeCapability({ token, audience: "https://console.mgpt.mn", secret })
    expect(verified).toMatchObject({ sub: "acc_runtime_test", authVersion: 1 })
    expect(await verifyGatewayAccount(request(token), token)).toEqual({
      accountID: "acc_runtime_test",
      authVersion: 1,
      kind: "runtime",
    })
  })

  test("rejects browser-audience, wrong-secret, and revoked runtime capabilities", async () => {
    const browserToken = await issueRuntimeCapability({
      accountID: "acc_runtime_test",
      authVersion: 1,
      audience: "https://runtime.mgpt.mn",
      secret,
    })
    const wrongSecretToken = await issueRuntimeCapability({
      accountID: "acc_runtime_test",
      authVersion: 1,
      audience: "https://console.mgpt.mn",
      secret: "different-runtime-auth-secret-with-at-least-thirty-two-characters",
    })
    const revokedToken = await issueRuntimeCapability({
      accountID: "acc_runtime_test",
      authVersion: 9,
      audience: "https://console.mgpt.mn",
      secret,
    })
    expect(await verifyGatewayAccount(request(browserToken), browserToken)).toBeUndefined()
    expect(await verifyGatewayAccount(request(wrongSecretToken), wrongSecretToken)).toBeUndefined()
    expect(await verifyGatewayAccount(request(revokedToken), revokedToken)).toBeUndefined()
  })

  test("runtime account automatically selects its sole active workspace", () => {
    expect(selectGatewayWorkspace({ kind: "runtime" }, ["wrk_one"], null)).toEqual({ workspaceID: "wrk_one" })
  })

  test("runtime account rejects an ambiguous workspace selection", () => {
    expect(selectGatewayWorkspace({ kind: "runtime" }, ["wrk_one", "wrk_two"], null)).toEqual({
      error: "workspace_ambiguous",
    })
  })

  test("runtime account must prove requested workspace membership", () => {
    expect(selectGatewayWorkspace({ kind: "runtime" }, ["wrk_one"], "wrk_other")).toEqual({
      error: "workspace_forbidden",
    })
  })

  test("CLI account keeps the existing explicit workspace requirement", () => {
    expect(selectGatewayWorkspace({ kind: "cli" }, ["wrk_one"], null)).toEqual({ error: "workspace_required" })
    expect(selectGatewayWorkspace({ kind: "cli" }, ["wrk_one"], "wrk_one")).toEqual({ workspaceID: "wrk_one" })
  })
})
