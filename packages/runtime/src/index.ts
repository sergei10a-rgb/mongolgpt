import { ContainerProxy, getSandbox, Sandbox, type Process } from "@cloudflare/sandbox"
import { createRuntimeHandler, createRuntimeProcessStarter, RUNTIME_PROCESS_ID, type RuntimeVariables } from "./runtime"
import { handleHistoryOutbound } from "./history-rpc"
import { handleCheckpointOutbound } from "./checkpoint-rpc"

export { ContainerProxy }

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
  static override get outboundHandlers() {
    return { history: handleHistoryOutbound, checkpoint: handleCheckpointOutbound }
  }

  enableInternet = false
  // Keep raw internet disabled while allowing the SDK proxy to mediate HTTPS egress.
  interceptHttps = true
  allowedHosts = ["*"]
  deniedHosts = blockedEgressHosts

  // SDK processId starts are not idempotent; coordinate on this DO instance.
  #startRuntimeProcess?: ReturnType<typeof createRuntimeProcessStarter<Process>>

  override startProcess(...args: Parameters<Sandbox["startProcess"]>): ReturnType<Sandbox["startProcess"]> {
    const options = args[1]
    if (options?.processId !== RUNTIME_PROCESS_ID) return super.startProcess(...args)
    this.#startRuntimeProcess ??= createRuntimeProcessStarter<Process>(() => super.getProcess(RUNTIME_PROCESS_ID))
    return this.#startRuntimeProcess(() => super.startProcess(...args))
  }
}

interface RuntimeEnvironment extends RuntimeVariables {
  Sandbox: DurableObjectNamespace<MongolGPTSandbox>
  HISTORY?: D1Database
  RUNTIME_BACKUPS?: R2Bucket
  MONGOLGPT_RUNTIME_BACKUP_KEYS?: string
}

const handler = createRuntimeHandler<RuntimeEnvironment>({
  sandbox: async (env, id, scope) => {
    if (
      env.MONGOLGPT_CLOUD_HISTORY === "true" &&
      (!env.HISTORY || !env.RUNTIME_BACKUPS || !env.MONGOLGPT_RUNTIME_BACKUP_KEYS)
    ) {
      throw new Error("Cloud сэргээх хадгалалт эсвэл түлхүүр тохируулаагүй байна.")
    }
    const sandbox = getSandbox(env.Sandbox, id, {
      normalizeId: true,
      sleepAfter: "10m",
      transport: "rpc",
    })
    // Scope is supplied by the verified Worker identity, never by sandbox request JSON.
    if (env.HISTORY) await sandbox.setOutboundByHost("history.mongolgpt.internal", "history", scope)
    if (env.MONGOLGPT_CLOUD_HISTORY === "true")
      await sandbox.setOutboundByHost("checkpoint.mongolgpt.internal", "checkpoint", scope)
    return sandbox
  },
  report: (failure) => {
    console.error("MongolGPT runtime хүсэлт амжилтгүй боллоо", {
      code: failure.code,
      diagnostic: failure.diagnostic,
    })
  },
})

export default {
  fetch(request, env) {
    return handler(request, env)
  },
} satisfies ExportedHandler<RuntimeEnvironment>
