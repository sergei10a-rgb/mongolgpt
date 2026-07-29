import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"

async function source(path: string) {
  return Bun.file(resolve(import.meta.dir, "..", path)).text()
}

describe("MongolGPT account access wiring", () => {
  test("revalidates web cookies and stores the OAuth auth version", async () => {
    const auth = await source("context/auth.ts")
    const callback = await source("routes/auth/[...callback].ts")
    const status = await source("routes/auth/status.ts")
    const app = await source("routes/auth/app.ts")

    expect(auth).toContain("resolveSessionAccess")
    expect(auth).toContain("AccountTable.auth_version")
    expect(auth).toContain('redirect("/auth/suspended")')
    expect(callback).toContain("verified.subject.properties.authVersion ?? 0")
    expect(status).toContain("account_suspended")
    expect(app).toContain("await getActor()")
  })

  test("revalidates CLI bearer and refresh tokens", async () => {
    const cli = await source("lib/cli-auth.ts")
    const refresh = await source("routes/auth/device/token.ts")

    expect(cli).toContain("AccountAccess.verify")
    expect(cli).toContain("authVersion")
    expect(refresh).toContain("await verifyCliToken(payload.access_token)")
    expect(refresh).toContain('"invalid_grant"')
  })

  test("gates model calls and model listing by active account state", async () => {
    const handler = await source("routes/zen/util/handler.ts")
    const models = await source("routes/zen/v1/models.ts")

    expect(handler).toContain("AccountTable.status")
    expect(handler).toContain('eq(AccountTable.status, "active")')
    expect(models).toContain("authenticatedWorkspace")
    expect(models).toContain("AccountTable.status")
    expect(models).toContain("verifyCliToken(token)")
    expect(models).toContain("status: 401")
  })
})
