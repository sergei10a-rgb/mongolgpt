import { ContainerProxy, getSandbox, Sandbox, type Process } from "@cloudflare/sandbox"
import {
  createRuntimeHandler,
  createRuntimeProcessStarter,
  deriveRuntimeIdentity,
  RUNTIME_PROCESS_ID,
  type RuntimeVariables,
} from "./runtime"
import { createSandboxRetirement, validateSandboxRetirement, type SandboxRetirement } from "./sandbox-retirement"
import { handleHistoryOutbound } from "./history-rpc"
import { createHistoryStore } from "./history"
import { registerRuntimeSandbox } from "./account-cleanup"
import { handleCheckpointOutbound } from "./checkpoint-rpc"
import { fetchRuntime, runtimeHttpHeader } from "./runtime-http"
import {
  deriveControlToken,
  sdkControlEnv,
  sdkControlHeader,
  checkpointControlHeader,
} from "@mongolgpt/runtime-auth/control"

export { ContainerProxy }
export { RuntimeAccountCleanup } from "./account-cleanup-service"

export const blockedEgressHosts = [
  "localhost",
  "*.localhost",
  "*.local",
  "metadata.google.internal",
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "::1",
  "fc00::/7",
  "fe80::/10",
]

export class MongolGPTSandbox extends Sandbox {
  #sdkToken: Promise<string>
  #retirement: ReturnType<typeof createSandboxRetirement>
  #retireEnvironment: RuntimeEnvironment
  #retireContext: DurableObjectState<{}>
  #stopping?: Promise<void>

  constructor(ctx: DurableObjectState<{}>, env: RuntimeEnvironment) {
    super(ctx, env)
    this.#retireContext = ctx
    this.#retireEnvironment = env
    this.#retirement = createSandboxRetirement(ctx.storage)
    this.#sdkToken = ctx.blockConcurrencyWhile(async () => {
      await this.#retirement.ready
      const token = await deriveControlToken(env.MONGOLGPT_RUNTIME_SECRET, ctx.id.toString(), "sdk")
      this.envVars = { ...this.envVars, [sdkControlEnv]: token }
      return token
    })
  }

  override async containerFetch(...args: Parameters<Sandbox["containerFetch"]>): Promise<Response> {
    return this.#retirement.run(() => this.#containerFetch(...args))
  }

  async #containerFetch(...args: Parameters<Sandbox["containerFetch"]>): Promise<Response> {
    const request =
      args[0] instanceof Request ? args[0] : new Request(args[0], typeof args[1] === "number" ? undefined : args[1])
    const port = typeof args[1] === "number" ? args[1] : (args[2] ?? this.defaultPort)
    // Workers only supports follow/manual. Never follow a privileged control redirect.
    const forwarded = new Request(request, port === 3000 ? { redirect: "manual" } : undefined)
    // Mutate the copy: Bun can inherit the original headers when init.headers is empty.
    forwarded.headers.delete(sdkControlHeader)
    forwarded.headers.delete(checkpointControlHeader)
    if (port === 3000) forwarded.headers.set(sdkControlHeader, await this.#sdkToken)
    const response = await super.containerFetch(forwarded, port)
    if (port === 3000 && response.status >= 300 && response.status < 400) {
      void response.body?.cancel().catch(() => {})
      throw new Error("SDK control redirects are forbidden")
    }
    return response
  }

  override async fetch(request: Request): Promise<Response> {
    return this.#retirement.run(() => this.#fetch(request))
  }

  async #fetch(request: Request): Promise<Response> {
    if (!request.headers.has(runtimeHttpHeader)) return super.fetch(request)
    if (request.headers.get(runtimeHttpHeader) !== "v1") return new Response(null, { status: 400 })
    const forwarded = new Request(request)
    forwarded.headers.delete(runtimeHttpHeader)
    return this.containerFetch(forwarded, 4096)
  }

  enableInternet = false
  // Keep raw internet disabled while allowing the SDK proxy to mediate HTTPS egress.
  interceptHttps = true
  allowedHosts = ["*"]
  deniedHosts = blockedEgressHosts

  // SDK processId starts are not idempotent; coordinate on this DO instance.
  #startRuntimeProcess?: ReturnType<typeof createRuntimeProcessStarter<Process>>

  override startProcess(...args: Parameters<Sandbox["startProcess"]>): ReturnType<Sandbox["startProcess"]> {
    return this.#retirement.run(() => this.#startProcess(...args))
  }

  #startProcess(...args: Parameters<Sandbox["startProcess"]>): ReturnType<Sandbox["startProcess"]> {
    const options = args[1]
    if (options?.processId !== RUNTIME_PROCESS_ID) return super.startProcess(...args)
    this.#startRuntimeProcess ??= createRuntimeProcessStarter<Process>(() => super.getProcess(RUNTIME_PROCESS_ID))
    return this.#startRuntimeProcess(() => super.startProcess(...args))
  }

  override start(...args: Parameters<Sandbox["start"]>): ReturnType<Sandbox["start"]> {
    return this.#retirement.run(() => super.start(...args))
  }

  override startAndWaitForPorts(
    ...args: Parameters<Sandbox["startAndWaitForPorts"]>
  ): ReturnType<Sandbox["startAndWaitForPorts"]> {
    return this.#retirement.run(() => super.startAndWaitForPorts(...args))
  }

  override onStart(): ReturnType<Sandbox["onStart"]> {
    return this.#retirement.run(() => super.onStart())
  }

  override wsConnect(...args: Parameters<Sandbox["wsConnect"]>): ReturnType<Sandbox["wsConnect"]> {
    return this.#retirement.run(() => super.wsConnect(...args))
  }

  // Worker-internal RPC, never a public or sandbox outbound route. This confirms
  // only container termination, not R2 upload drainage or account erasure.
  async retireAccount(value: SandboxRetirement) {
    const input = validateSandboxRetirement(value)
    const env = this.#retireEnvironment
    const ctx = this.#retireContext
    const identity = await deriveRuntimeIdentity(input.accountID, input.workspaceID, env.MONGOLGPT_RUNTIME_SECRET)
    if (!env.HISTORY) throw new Error("Устгалын хамгаалалт тохируулаагүй байна.")
    if (env.Sandbox.idFromName(identity.sandboxID).toString() !== ctx.id.toString()) {
      const registered = await env.HISTORY.prepare(
        `SELECT object_id FROM runtime_sandbox
        WHERE object_id = ? AND account_id = ? AND workspace_id = ?`,
      )
        .bind(ctx.id.toString(), input.accountID, input.workspaceID)
        .first<{ object_id: string }>()
      if (registered?.object_id !== ctx.id.toString()) throw new Error("Ажиллах орчны устгалын хүрээ зөрсөн байна.")
    }
    const retired = await env.HISTORY.prepare("SELECT account_id FROM runtime_history_retirement WHERE account_id = ?")
      .bind(input.accountID)
      .first()
    if (!retired) throw new Error("Аккаунтын устгал эхлээгүй байна.")
    await this.#retirement.seal(input)
    this.#stopping ??= this.#stopRetiredContainer()
    const stopping = this.#stopping
    try {
      await stopping
    } finally {
      if (this.#stopping === stopping) this.#stopping = undefined
    }
    return { ...input, stopped: true as const }
  }

  async #stopRetiredContainer() {
    await super.destroy()
    await this.#retirement.drain()
    // A start admitted before sealing could have resumed after the first stop.
    if (this.#retireContext.container?.running) await super.destroy()
    if (!this.#retireContext.container || this.#retireContext.container.running)
      throw new Error("Ажиллах орчин зогссоныг баталгаажуулж чадсангүй.")
  }
}

// The inherited setter registers handlers for this concrete class in the SDK.
MongolGPTSandbox.outboundHandlers = { history: handleHistoryOutbound, checkpoint: handleCheckpointOutbound }

export interface RuntimeEnvironment extends RuntimeVariables {
  Sandbox: DurableObjectNamespace<MongolGPTSandbox>
  HISTORY?: D1Database
  RUNTIME_BACKUPS?: R2Bucket
  MONGOLGPT_RUNTIME_BACKUP_KEYS?: string
  MONGOLGPT_RUNTIME_ACCOUNT_CLEANUP?: string
}

const handler = createRuntimeHandler<RuntimeEnvironment>({
  sandbox: async (env, id, scope) => {
    if (
      env.MONGOLGPT_CLOUD_HISTORY === "true" &&
      (!env.HISTORY || !env.RUNTIME_BACKUPS || !env.MONGOLGPT_RUNTIME_BACKUP_KEYS)
    ) {
      throw new Error("Cloud сэргээх хадгалалт эсвэл түлхүүр тохируулаагүй байна.")
    }
    if (env.HISTORY) await createHistoryStore(env.HISTORY).assertActive(scope)
    if (env.HISTORY) await registerRuntimeSandbox(env.HISTORY, scope, env.Sandbox.idFromName(id).toString())
    const sandbox = getSandbox(env.Sandbox, id, {
      normalizeId: true,
      sleepAfter: "10m",
      transport: "rpc",
    })
    // Scope is supplied by the verified Worker identity, never by sandbox request JSON.
    if (env.HISTORY) await sandbox.setOutboundByHost("history.mongolgpt.internal", "history", scope)
    if (env.MONGOLGPT_CLOUD_HISTORY === "true")
      await sandbox.setOutboundByHost("checkpoint.mongolgpt.internal", "checkpoint", scope)
    return {
      getProcess: (processID) => sandbox.getProcess(processID),
      startProcess: (command, options) => sandbox.startProcess(command, options),
      containerFetch: (request, port) => fetchRuntime(sandbox, request, port),
      wsConnect: (request, port) => sandbox.wsConnect(request, port),
    }
  },
  report: (failure) => {
    console.error("MongolGPT runtime хүсэлт амжилтгүй боллоо", {
      code: failure.code,
      diagnostic: failure.diagnostic,
      readiness: failure.readiness,
      readinessBudgetMs: failure.readinessBudgetMs,
    })
  },
})

export default {
  fetch(request, env) {
    return handler(request, env)
  },
} satisfies ExportedHandler<RuntimeEnvironment>
