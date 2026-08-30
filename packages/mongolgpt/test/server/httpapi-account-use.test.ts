import { describe, expect, test } from "bun:test"
import {
  accountUseAllowed,
  accountUseRoute,
  configureDesktopSmokeProof,
  desktopSmokeProofMatches,
} from "../../src/server/routes/instance/httpapi/middleware/account-use"

describe("HTTP account use gate", () => {
  test("protects session creation and model-using actions", () => {
    for (const pathname of [
      "/session",
      "/session/session-1/init",
      "/session/session-1/summarize",
      "/session/session-1/message",
      "/session/session-1/prompt_async",
      "/session/session-1/command",
      "/session/session-1/shell",
      "/api/session",
      "/api/session/session-1/agent",
      "/api/session/session-1/model",
      "/api/session/session-1/prompt",
      "/api/session/session-1/compact",
    ]) {
      expect(accountUseRoute("POST", pathname), pathname).toBe(true)
    }
  })

  test("leaves login, setup, reads, and non-model session actions available", () => {
    for (const [method, pathname] of [
      ["GET", "/session"],
      ["POST", "/experimental/account/login"],
      ["GET", "/experimental/account"],
      ["PUT", "/auth/provider"],
      ["POST", "/session/session-1/abort"],
      ["POST", "/session/session-1/share"],
      ["POST", "/api/session/session-1/wait"],
      ["POST", "/api/session/session-1/interrupt"],
    ]) {
      expect(accountUseRoute(method, pathname), `${method} ${pathname}`).toBe(false)
    }
  })

  test("requires an active workspace in installed builds", () => {
    for (const channel of ["dev", "beta", "latest", "prod"]) {
      expect(accountUseAllowed({ channel }), channel).toBe(false)
      expect(accountUseAllowed({ channel, activeOrgID: "   " }), channel).toBe(false)
      expect(accountUseAllowed({ channel, activeOrgID: "workspace-1" }), channel).toBe(true)
    }
  })

  test("accepts authenticated hosted runtime and preserves source development", () => {
    expect(accountUseAllowed({ channel: "latest", hostedRuntime: true, serverAuthRequired: true })).toBe(true)
    expect(accountUseAllowed({ channel: "latest", hostedRuntime: true, serverAuthRequired: false })).toBe(false)
    expect(accountUseAllowed({ channel: "local" })).toBe(true)
  })

  test("accepts only an exact non-empty one-time desktop smoke proof", () => {
    const proof = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE"
    expect(desktopSmokeProofMatches(proof, proof)).toBe(true)
    expect(desktopSmokeProofMatches(proof, `${proof}x`)).toBe(false)
    expect(desktopSmokeProofMatches(proof, "release-smoke-proof-0000000000")).toBe(false)
    expect(desktopSmokeProofMatches(proof, undefined)).toBe(false)
    expect(desktopSmokeProofMatches(undefined, proof)).toBe(false)
    expect(desktopSmokeProofMatches("", "")).toBe(false)
    expect(() => configureDesktopSmokeProof(proof)).not.toThrow()
    expect(() => configureDesktopSmokeProof("short")).toThrow("32-byte base64url")
    expect(() => configureDesktopSmokeProof(undefined)).not.toThrow()
  })
})
