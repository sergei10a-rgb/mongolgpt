import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  hasDisabledMcp,
  hasMessageText,
  hasProviderModel,
  isFileContent,
  isExternalPtyProof,
  isPath,
  isProject,
  isSession,
  isProviderConfig,
  isProviderList,
  isStatusArray,
  isToolIds,
  releaseSmokeTerminalCommand,
  redactSmokeError,
  sameLocalPath,
  smokeTimeoutMs,
  validateHttpResponse,
} from "./release-functional-smoke"

describe("release functional smoke validators", () => {
  test("fails closed on status, content type, and malformed schemas", () => {
    const json = new Headers({ "content-type": "application/json; charset=utf-8" })
    expect(validateHttpResponse({ status: 200, headers: json }, "application/json")).toBe(true)
    expect(validateHttpResponse({ status: 204, headers: json }, "application/json")).toBe(false)
    expect(
      validateHttpResponse({ status: 200, headers: new Headers({ "content-type": "text/plain" }) }, "application/json"),
    ).toBe(false)
    expect(isPath({ home: "x", state: "x", config: "x", worktree: "x", directory: "x" })).toBe(true)
    expect(isPath({ home: "x" })).toBe(false)
    expect(isProject({ id: "project", worktree: "C:\\repo" })).toBe(true)
    expect(isProject({ id: "project" })).toBe(false)
    expect(isSession({ id: "session-1" })).toBe(true)
    expect(isSession({ id: "" })).toBe(false)
    expect(isFileContent({ type: "text", content: "README" })).toBe(true)
    expect(isFileContent({ type: "text", content: 1 })).toBe(false)
    expect(isStatusArray([{ file: "README.md", status: "modified" }])).toBe(true)
    expect(isStatusArray([{ file: "README.md" }])).toBe(false)
  })

  test("accepts only the exact provider response families", () => {
    expect(isProviderList({ all: [], default: {}, connected: [] })).toBe(true)
    expect(isProviderList({ all: [], default: {} })).toBe(false)
    expect(isProviderConfig({ providers: [], default: {} })).toBe(true)
    expect(isProviderConfig({ providers: {}, default: {} })).toBe(false)
  })

  test("proves exact tool, MCP, provider, and model registrations", () => {
    expect(isToolIds(["read", "desktop-smoke"])).toBe(true)
    expect(isToolIds(["desktop-smoke", 1])).toBe(false)
    expect(hasDisabledMcp({ "release-functional-smoke-mcp": { status: "disabled" } })).toBe(true)
    expect(hasDisabledMcp({ other: { status: "disabled" } })).toBe(false)
    expect(
      hasProviderModel({
        all: [
          {
            id: "release-functional-smoke-provider",
            models: { "release-functional-smoke-model": { name: "fixture" } },
          },
        ],
        default: {},
        connected: [],
      }),
    ).toBe(true)
    expect(
      hasProviderModel({
        all: [{ id: "other", models: { "release-functional-smoke-model": { name: "fixture" } } }],
        default: {},
        connected: [],
      }),
    ).toBe(false)
  })

  test("finds the deterministic assistant reply in prompt and message payloads", () => {
    const reply = "MongolGPT Desktop локал загварын smoke амжилттай"
    expect(hasMessageText({ parts: [{ type: "text", text: reply }] }, reply)).toBe(true)
    expect(hasMessageText({ parts: [{ type: "text", text: "өөр хариу" }] }, reply)).toBe(false)
  })

  test("keeps timeout and secret handling deterministic", () => {
    expect(smokeTimeoutMs(250)).toBe(250)
    expect(smokeTimeoutMs(0)).toBe(10_000)
    expect(redactSmokeError("password=secret secret", "secret")).toBe("password=[redacted] [redacted]")
    expect(redactSmokeError("no secret", "")).toBe("no secret")
    expect(isExternalPtyProof("MONGOLGPT_PACKAGED_PTY_OK\n")).toBe(true)
    expect(isExternalPtyProof("MONGOLGPT_PACKAGED_PTY_OK extra")).toBe(false)
  })

  test("compares Windows path aliases by filesystem identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "mongolgpt-path-identity-"))
    try {
      expect(await sameLocalPath(root, join(root, "."))).toBe(true)
      expect(await sameLocalPath(root, join(root, "missing"))).toBe(false)
      if (process.platform === "win32") expect(await sameLocalPath(root, root.toUpperCase())).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("encodes the Windows terminal proof without command-line quoting", () => {
    const command = releaseSmokeTerminalCommand()
    expect(command.command).toBe("powershell.exe")
    expect(command.args.slice(0, 4)).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"])
    const script = Buffer.from(command.args[4] ?? "", "base64").toString("utf16le")
    expect(script).toContain("MONGOLGPT_SMOKE_ROOT")
    expect(script).toContain("MONGOLGPT_SMOKE_PROOF")
    expect(script).toContain("status --short")
    expect(script).toContain("git -C $env:MONGOLGPT_SMOKE_ROOT diff")
  })
})
