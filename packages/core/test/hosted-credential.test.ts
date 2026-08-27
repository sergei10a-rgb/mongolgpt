import { afterEach, describe, expect, test } from "bun:test"
import { issueRuntimeCapability } from "@mongolgpt/runtime-auth"
import { HostedCredential } from "../src/hosted-credential"

const secret = "runtime-auth-secret-that-is-longer-than-thirty-two-characters"
const originalMode = process.env.MONGOLGPT_RUNTIME_MODE
const originalKey = process.env.MONGOLGPT_API_KEY

afterEach(() => {
  HostedCredential.clear()
  if (originalMode === undefined) delete process.env.MONGOLGPT_RUNTIME_MODE
  else process.env.MONGOLGPT_RUNTIME_MODE = originalMode
  if (originalKey === undefined) delete process.env.MONGOLGPT_API_KEY
  else process.env.MONGOLGPT_API_KEY = originalKey
})

async function capability(now: number) {
  return issueRuntimeCapability({
    accountID: "account-1",
    workspaceID: "wrk_123",
    authVersion: 3,
    audience: "https://dev.mgpt.mn",
    secret,
    ttlSeconds: 90,
    now,
    jti: "hosted-credential-test",
  })
}

describe("hosted runtime credential", () => {
  test("recognizes the account-authenticated runtime placeholder only in hosted mode", () => {
    process.env.MONGOLGPT_RUNTIME_MODE = "hosted"
    expect(HostedCredential.isRuntimePlaceholder(HostedCredential.EnvironmentName, HostedCredential.Placeholder)).toBe(
      true,
    )
    expect(HostedCredential.isRuntimePlaceholder("OTHER_KEY", HostedCredential.Placeholder)).toBe(false)
    delete process.env.MONGOLGPT_RUNTIME_MODE
    expect(HostedCredential.isRuntimePlaceholder(HostedCredential.EnvironmentName, HostedCredential.Placeholder)).toBe(
      false,
    )
  })

  test("keeps the capability in memory and resolves only the harmless runtime placeholder", async () => {
    const now = Math.floor(Date.now() / 1000)
    const token = await capability(now)
    process.env.MONGOLGPT_RUNTIME_MODE = "hosted"
    process.env.MONGOLGPT_API_KEY = HostedCredential.Placeholder

    expect(HostedCredential.capture(token, now * 1000)).toBe(true)
    expect(HostedCredential.resolve("MONGOLGPT_API_KEY", process.env.MONGOLGPT_API_KEY, now * 1000)).toBe(token)
    expect(process.env.MONGOLGPT_API_KEY).toBe(HostedCredential.Placeholder)
    expect(HostedCredential.resolve("OTHER_API_KEY", "local-secret", now * 1000)).toBe("local-secret")
  })

  test("does not activate outside hosted runtime mode", async () => {
    const now = Math.floor(Date.now() / 1000)
    const token = await capability(now)
    delete process.env.MONGOLGPT_RUNTIME_MODE

    expect(HostedCredential.capture(token, now * 1000)).toBe(false)
    expect(HostedCredential.resolve("MONGOLGPT_API_KEY", HostedCredential.Placeholder, now * 1000)).toBe(
      HostedCredential.Placeholder,
    )
  })

  test("rejects malformed capabilities and clears expired credentials", async () => {
    const now = Math.floor(Date.now() / 1000)
    const token = await capability(now)
    process.env.MONGOLGPT_RUNTIME_MODE = "hosted"

    expect(HostedCredential.capture("not-a-capability", now * 1000)).toBe(false)
    expect(HostedCredential.capture(token, now * 1000)).toBe(true)
    expect(
      HostedCredential.resolve("MONGOLGPT_API_KEY", HostedCredential.Placeholder, (now + 91) * 1000),
    ).toBeUndefined()
  })
})
