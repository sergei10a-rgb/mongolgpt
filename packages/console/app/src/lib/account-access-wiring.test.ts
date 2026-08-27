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
    expect(auth).toContain("MONGOLGPT_GATEWAY_SESSION_SECRET")
    expect(auth).not.toContain("ZEN_SESSION_SECRET")
    expect(auth).toContain('redirect("/auth/suspended")')
    expect(callback).toContain("verified.subject.properties.authVersion ?? 0")
    expect(status).toContain("account_suspended")
    expect(app).toContain("await getActor()")
  })

  test("revalidates CLI bearer and refresh tokens", async () => {
    const cli = await source("lib/cli-auth.ts")
    const refresh = await source("routes/auth/device/token-handler.ts")

    expect(cli).toContain("AccountAccess.verify")
    expect(cli).toContain("authVersion")
    expect(cli).toContain("verifyRuntimeCapability")
    expect(cli).toContain("MongolGPTRuntimeAuthSecret")
    expect(cli).toContain("workspace_ambiguous")
    expect(refresh).toContain("await input.verifyToken(parsed.data.access_token)")
    expect(refresh).toContain('"invalid_grant"')
  })

  test("gates model calls and model listing by active account state", async () => {
    const handler = await source("routes/gateway/util/handler.ts")
    const models = await source("routes/gateway/v1/models.ts")
    const modelsHandler = await source("routes/gateway/util/modelsHandler.ts")
    const modelConfig = await source("../../core/src/model-config.ts")

    expect(handler).toContain("AccountTable.status")
    expect(handler).toContain('eq(AccountTable.status, "active")')
    expect(models).toContain("authenticatedWorkspace")
    expect(models).toContain("AccountTable.status")
    expect(models).toContain("verifyGatewayAccount(request, token)")
    expect(handler).toContain("verifyGatewayAccount(input.request, gatewayApiKey)")
    expect(handler).toContain("if (!gatewayApiKey)")
    expect(handler).toContain("if (!authInfo) throw new AuthError")
    expect(modelConfig).toContain('modelID !== "free-auto"')
    expect(modelConfig).toContain("model.allowAnonymous !== false")
    expect(modelConfig).toContain("model.freeForAuthenticated !== true")
    expect(models).toContain("buildAuthenticatedModelsResponse(input.request")
    expect(modelsHandler).toContain('request.headers.get("authorization")')
    expect(modelsHandler).toContain("authorization?.match(/^Bearer")
    expect(modelsHandler).toContain("if (!token) return buildModelsUnauthorizedResponse()")
    expect(modelsHandler).toContain("status: 401")
  })
})
