import { MongolGPTSandbox } from "../../src/index"
import { deriveRuntimeIdentity } from "../../src/runtime"
import { createHistoryStore } from "../../src/history"

export { ContainerProxy } from "../../src/index"

const scope = {
  accountID: "acc_retirement_probe",
  workspaceID: "wrk_retirement_probe",
  requestID: "del_retirement_probe",
}
type Environment = Omit<ConstructorParameters<typeof MongolGPTSandbox>[1], "Sandbox" | "HISTORY"> & {
  Sandbox: DurableObjectNamespace<RetirementSandbox>
  HISTORY: D1Database
}

// Only the external container boundary is simulated. Identity, SDK teardown,
// D1 queries, DO RPC, constructor gates and storage run in actual workerd.
export class RetirementSandbox extends MongolGPTSandbox {
  #instance = crypto.randomUUID()
  #state: DurableObjectState<{}>

  constructor(ctx: DurableObjectState<{}>, env: Environment) {
    const storage = ctx.storage.kv
    Object.defineProperty(ctx, "container", {
      value: {
        get running() {
          return storage.get("fixture:running") === true
        },
        start() {
          storage.put("fixture:running", true)
        },
        async destroy() {
          storage.put("fixture:running", false)
          storage.put("fixture:stops", Number(storage.get("fixture:stops") ?? 0) + 1)
        },
        monitor: () => new Promise<void>(() => {}),
        getTcpPort() {
          throw new Error("fixture unexpected container I/O")
        },
      },
    })
    super(ctx, env)
    this.#state = ctx
  }

  prepare() {
    this.#state.container!.start()
  }

  status() {
    return {
      instance: this.#instance,
      running: this.#state.container!.running,
      stops: Number(this.#state.storage.kv.get("fixture:stops") ?? 0),
      seal: this.#state.storage.kv.get("mongolgpt:retired:v1") ?? null,
    }
  }

  restart() {
    this.#state.abort("synthetic retirement restart")
  }

  async denied() {
    const operations: Array<() => Promise<unknown>> = [
      () => this.start(),
      () => this.startAndWaitForPorts([4096]),
      () => this.startProcess("must-not-run"),
      () => this.onStart(),
      () => this.fetch(new Request("http://sandbox/")),
      () => this.containerFetch(new Request("http://sandbox/"), 4096),
      () => this.wsConnect(new Request("http://sandbox/", { headers: { upgrade: "websocket" } }), 4096),
    ]
    const results: boolean[] = []
    for (const operation of operations) {
      try {
        await operation()
        results.push(false)
      } catch (error) {
        results.push(error instanceof Error && error.message.includes("хаагдсан"))
      }
    }
    return results
  }
}

RetirementSandbox.outboundHandlers = MongolGPTSandbox.outboundHandlers!

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (request.method !== "POST" || !["localhost", "127.0.0.1"].includes(url.hostname))
      return new Response(null, { status: 404 })
    if (url.pathname === "/migrate") {
      const statements = await request.json<string[]>()
      for (const statement of statements) await env.HISTORY.prepare(statement).run()
      return Response.json({ ok: true })
    }
    const identity = await deriveRuntimeIdentity(scope.accountID, scope.workspaceID, env.MONGOLGPT_RUNTIME_SECRET)
    const sandbox = env.Sandbox.getByName(identity.sandboxID)
    try {
      switch (url.pathname) {
        case "/prepare":
          await sandbox.prepare()
          return Response.json(await sandbox.status())
        case "/state":
          return Response.json(await sandbox.status())
        case "/fence":
          await createHistoryStore(env.HISTORY).retire(scope.accountID)
          return Response.json({ ok: true })
        case "/retire":
          return Response.json(await sandbox.retireAccount(scope))
        case "/wrong-scope":
          return Response.json(await sandbox.retireAccount({ ...scope, workspaceID: "wrk_other" }))
        case "/denied":
          return Response.json(await sandbox.denied())
        case "/restart":
          await sandbox.restart()
          return Response.json({ ok: false })
        default:
          return new Response(null, { status: 404 })
      }
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : "unknown" }, { status: 409 })
    }
  },
} satisfies ExportedHandler<Environment>
