import { describe, expect, test } from "bun:test"
import { createAccountConfig, selectAccountWorkspace } from "./account-config"

describe("account-scoped MongolGPT config", () => {
  test("wires Free Auto to the current console and selected workspace", () => {
    const config = createAccountConfig({ origin: "https://mgpt.mn", workspaceID: "workspace-1" })
    const provider = config.provider.mongolgpt

    expect(provider.api).toBe("https://mgpt.mn/zen/v1")
    expect(provider.options).toEqual({
      apiKey: "{env:MONGOLGPT_CONSOLE_TOKEN}",
      baseURL: "https://mgpt.mn/zen/v1",
      headers: { "x-org-id": "workspace-1" },
    })
    expect(provider.models["free-auto"]).toMatchObject({
      name: "MongolGPT Free Auto",
      cost: { input: 0, output: 0 },
      tool_call: true,
    })
  })

  test("does not serialize an account access token into remote config", () => {
    const value = JSON.stringify(createAccountConfig({ origin: "https://mgpt.mn", workspaceID: "workspace-1" }))

    expect(value).not.toContain("Bearer ")
    expect(value).not.toContain("access_token")
    expect(value).not.toContain("refresh_token")
  })

  test("does not silently select a workspace when an account has multiple organizations", () => {
    expect(selectAccountWorkspace([{ workspaceID: "workspace-1" }, { workspaceID: "workspace-2" }], false)).toEqual({
      status: "organization-required",
    })
    expect(selectAccountWorkspace([{ workspaceID: "workspace-2" }], true)).toEqual({
      status: "selected",
      workspaceID: "workspace-2",
    })
  })
})
