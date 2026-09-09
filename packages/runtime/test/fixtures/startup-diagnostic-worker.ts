import { getSandbox } from "@cloudflare/sandbox"
import { DurableObject } from "cloudflare:workers"
import { matchesControlToken } from "@mongolgpt/runtime-auth/control"
import { startupDiagnosticPath } from "@mongolgpt/runtime-auth/startup-diagnostic"
import { deriveRuntimeIdentity } from "../../src/runtime"
import { CanarySandbox, canaryScope } from "./cloudflare-canary"
import { persistCanaryStartup, readCanaryStartup } from "./canary-startup"

export { ContainerProxy } from "./cloudflare-canary"

type Environment = ConstructorParameters<typeof CanarySandbox>[1] & {
  CANARY_RUN_ID: string
  CANARY_ADMIN_TOKEN: string
}

// Workerd cannot instantiate a Container without Docker. Exercise the same
// persistence functions on real DO storage; VM lifecycle is a separate canary gate.
export class StartupEvidence extends DurableObject {
  async configure() {}
  async recordStartupFailure(input: unknown) {
    await this.ctx.storage.put("canary:bootCount", 1)
    await persistCanaryStartup(this.ctx.storage, input)
  }
  async startupFailure() {
    return readCanaryStartup(this.ctx.storage)
  }
}

// Local-only transport proof using the actual canary handler registry.
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    if (
      !["localhost", "127.0.0.1"].includes(url.hostname) ||
      !matchesControlToken(request.headers.get("x-test-admin-token"), env.CANARY_ADMIN_TOKEN)
    )
      return new Response(null, { status: 403 })
    if (url.search || url.hash) return new Response(null, { status: 400 })
    if (request.method === "GET" && url.pathname === "/__test/receipt") {
      const identity = await deriveRuntimeIdentity(
        canaryScope.accountID,
        canaryScope.workspaceID,
        env.MONGOLGPT_RUNTIME_SECRET,
      )
      const sandbox = getSandbox(env.Sandbox, identity.sandboxID, {
        normalizeId: true,
        transport: "rpc",
        sleepAfter: "10m",
      }) as CanarySandbox
      return Response.json(await sandbox.startupFailure())
    }
    if (request.method !== "POST" || url.pathname !== startupDiagnosticPath) return new Response(null, { status: 404 })
    // Own the loopback request body before transferring it to another entrypoint.
    const body = await request.arrayBuffer()
    if (body.byteLength > 512) return new Response(null, { status: 413 })
    const forwarded = new Request(`http://checkpoint.mongolgpt.internal${startupDiagnosticPath}`, {
      method: "POST",
      headers: request.headers,
      body,
    })
    forwarded.headers.delete("x-test-admin-token")
    const entrypoints = (
      ctx as ExecutionContext & {
        exports: { ContainerProxy(options: { props: Record<string, unknown> }): Fetcher }
      }
    ).exports
    return entrypoints
      .ContainerProxy({
        props: {
          className: CanarySandbox.name,
          containerId: "startup-diagnostic-loopback",
          outboundByHostOverrides: { "checkpoint.mongolgpt.internal": { method: "checkpoint", params: canaryScope } },
          enableInternet: false,
          allowedHosts: ["*"],
          deniedHosts: [],
          interceptAll: true,
        },
      })
      .fetch(forwarded)
  },
} satisfies ExportedHandler<Environment>
