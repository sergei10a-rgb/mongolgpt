import { getSandbox } from "@cloudflare/sandbox"
import { matchesControlToken, sdkControlEnv, sdkControlHeader } from "@mongolgpt/runtime-auth/control"
import { MongolGPTSandbox } from "../../src/index"

export { ContainerProxy } from "../../src/index"

const sandboxID = "control-probe-sandbox"
const listenerID = "control-probe-port-listener"
// The isolated runner copies its Bun executable here before starting the SDK.
const listenerCommand =
  `/tmp/tenant-bun -e 'setTimeout(() => process.exit(0), 10000); ` +
  `setTimeout(() => Bun.serve({hostname:"0.0.0.0",port:4097,fetch:() => new Response("probe")}), 250)'`
type Environment = ConstructorParameters<typeof MongolGPTSandbox>[1] & { EXPECTED_SDK_TOKEN: string }

function receipts() {
  return {
    starts: 0,
    startTokenMatched: false,
    onStarts: 0,
    healthProbes: 0,
    rpcAttempts: 0,
    rpcTokenMatched: false,
    rpcUpgrades: 0,
    rpcResponseMessages: 0,
    rpcStatuses: [] as number[],
    rpcFailureBody: "",
    forwardingFailure: "",
  }
}

// Only the platform container boundary is substituted. Storage, constructor
// gates, SDK control client, and Containers' WebSocketPair proxy stay real.
export class SandboxControlWorker extends MongolGPTSandbox {
  #receipts: ReturnType<typeof receipts>

  constructor(ctx: DurableObjectState<{}>, env: Environment) {
    const observed = receipts()
    let running = false
    const container = {
      get running() {
        return running
      },
      start(options?: ContainerStartupOptions) {
        if (running) throw new Error("probe duplicate start")
        observed.startTokenMatched = matchesControlToken(options?.env?.[sdkControlEnv] ?? null, env.EXPECTED_SDK_TOKEN)
        if (!observed.startTokenMatched) throw new Error("probe start token mismatch")
        observed.starts++
        running = true
      },
      monitor: () => new Promise<void>(() => {}),
      interceptOutboundHttp: async () => {},
      interceptOutboundHttps: async () => {},
      interceptAllOutboundHttp: async () => {},
      getTcpPort(port: number) {
        if (port !== 3000) throw new Error("probe unexpected port")
        return {
          async fetch(input: Request | string | URL, init?: RequestInit | Request) {
            const request = new Request(input, init)
            const url = new URL(request.url)
            const health = url.href === "http://ping/" || url.href === "http://containerstarthealthcheck/"
            if (!running || request.method !== "GET" || url.search || (!health && url.pathname !== "/rpc"))
              throw new Error("probe unexpected platform request")
            if (health) {
              observed.healthProbes++
            } else {
              observed.rpcAttempts++
              observed.rpcTokenMatched = matchesControlToken(
                request.headers.get(sdkControlHeader),
                env.EXPECTED_SDK_TOKEN,
              )
              if (!observed.rpcTokenMatched || observed.onStarts < 1 || request.headers.get("upgrade") !== "websocket")
                throw new Error("probe RPC ordering or token mismatch")
            }
            const response = await fetch(new Request(`http://127.0.0.1:3000${url.pathname}`, request))
            if (!health) {
              observed.rpcStatuses.push(response.status)
              if (response.status !== 101) {
                const body = await response.clone().text()
                observed.rpcFailureBody = diagnostic(new Error(body), env)
              }
            }
            if (!health && response.status === 101 && response.webSocket) {
              observed.rpcUpgrades++
              response.webSocket.addEventListener("message", () => observed.rpcResponseMessages++)
            }
            return response
          },
        }
      },
    }
    // Keep workerd's branded state object intact for DurableObjectBase.
    Object.defineProperty(ctx, "container", { value: container })
    Object.defineProperty(ctx.id, "toString", { value: () => sandboxID })
    super(ctx, env)
    this.#receipts = observed
  }

  override async onStart() {
    await super.onStart()
    this.#receipts.onStarts++
  }

  override async containerFetch(...args: Parameters<MongolGPTSandbox["containerFetch"]>): Promise<Response> {
    try {
      return await super.containerFetch(...args)
    } catch (error) {
      this.#receipts.forwardingFailure = diagnostic(error, this.env as Environment)
      throw error
    }
  }

  probeReceipts() {
    return { ...this.#receipts }
  }
}

const handlers = MongolGPTSandbox.outboundHandlers
if (!handlers) throw new Error("probe production handlers missing")
SandboxControlWorker.outboundHandlers = handlers

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (
      !["localhost", "127.0.0.1"].includes(url.hostname) ||
      url.pathname !== "/probe" ||
      url.search ||
      request.method !== "POST"
    )
      return Response.json({ ok: false, phase: "route_gate" }, { status: 404 })
    if ((await request.arrayBuffer()).byteLength !== 0)
      return Response.json({ ok: false, phase: "body_gate" }, { status: 404 })
    if (!/^[0-9a-f]{64}$/.test(env.EXPECTED_SDK_TOKEN) || !/^[0-9a-f]{64}$/.test(env.MONGOLGPT_RUNTIME_SECRET))
      return new Response(null, { status: 403 })

    const sandbox = getSandbox(env.Sandbox, sandboxID, { normalizeId: true, transport: "rpc", sleepAfter: "10m" })
    let phase = "configure"
    let firstMissing = false
    let secondMissing = false
    let startAttempted = false
    const sessionID = `control-probe-port-session-${crypto.randomUUID()}`
    let sessionAttempted = false
    let failure: { phase: string; error: string } | undefined
    const cleanupErrors: string[] = []
    const listener = {
      sessionCreated: false,
      started: false,
      explicitSession: false,
      portReady: false,
      postWatchLookup: false,
      killAttempted: false,
      killCompleted: false,
      stopped: false,
      sessionDeleteAttempted: false,
      sessionDeleted: false,
    }
    const deadline = Date.now() + 30_000
    const step = <T>(work: Promise<T>) => bounded(work, Math.max(1, Math.min(8000, deadline - Date.now())), phase)
    try {
      await step(sandbox.setTransport("rpc"))
      phase = "first_lookup"
      firstMissing = (await step(sandbox.getProcess("control-probe-missing-first"))) === null
      phase = "second_lookup"
      secondMissing = (await step(sandbox.getProcess("control-probe-missing-second"))) === null
      phase = "listener_absent"
      if ((await step(sandbox.getProcess(listenerID))) !== null) throw new Error("probe listener already exists")
      phase = "session_create"
      sessionAttempted = true
      // Default-session creation requires /workspace, absent in this isolated
      // runner. Exercise an actual persistent session without creating host paths.
      const session = await step(sandbox.createSession({ id: sessionID, cwd: "/tmp/sdk-home" }))
      listener.sessionCreated = session.id === sessionID
      if (!listener.sessionCreated) throw new Error("probe session identity mismatch")
      phase = "listener_start"
      startAttempted = true
      const process = await step(
        session.startProcess(listenerCommand, {
          processId: listenerID,
          cwd: "/tmp/sdk-home",
          env: { BUN_BE_BUN: "1" },
          timeout: 10_000,
          autoCleanup: false,
        }),
      )
      listener.started = process.id === listenerID
      listener.explicitSession = process.sessionId === sessionID
      if (!listener.started || !listener.explicitSession) throw new Error("probe process or explicit session mismatch")
      phase = "port_watch"
      // SDK's own timer starts after watchPort returns its stream. Bound both.
      await step(process.waitForPort(4097, { mode: "tcp", timeout: 5000, interval: 100 }))
      listener.portReady = true
      phase = "post_watch_lookup"
      const found = await step(sandbox.getProcess(listenerID))
      listener.postWatchLookup = found?.id === listenerID && found.status === "running"
      if (!listener.postWatchLookup) throw new Error("probe listener not running after port watch")
    } catch (error) {
      failure = { phase, error: diagnostic(error, env) }
    } finally {
      if (startAttempted) {
        listener.killAttempted = true
        try {
          await bounded(sandbox.killProcess(listenerID), 3000, "listener_kill")
          listener.killCompleted = true
          const stopped = await bounded(sandbox.getProcess(listenerID), 3000, "cleanup_lookup")
          listener.stopped =
            stopped?.id === listenerID && ["completed", "failed", "killed", "error"].includes(stopped.status)
          if (!listener.stopped) throw new Error("probe listener termination not confirmed")
        } catch (error) {
          cleanupErrors.push(diagnostic(error, env))
        }
      }
      if (sessionAttempted) {
        listener.sessionDeleteAttempted = true
        try {
          const deleted = await bounded(sandbox.deleteSession(sessionID), 3000, "session_delete")
          listener.sessionDeleted = deleted.success === true && deleted.sessionId === sessionID
          if (!listener.sessionDeleted) throw new Error("probe session deletion not confirmed")
        } catch (error) {
          cleanupErrors.push(diagnostic(error, env))
        }
      }
    }
    const ok = !failure && cleanupErrors.length === 0
    return Response.json(
      {
        ok,
        ...failure,
        ...(cleanupErrors.length > 0 && { cleanupErrors }),
        firstMissing,
        secondMissing,
        listener,
        receipts: await bounded(Promise.resolve(sandbox.probeReceipts()), 3000, "receipts"),
      },
      { status: ok ? 200 : 502 },
    )
  },
} satisfies ExportedHandler<Omit<Environment, "Sandbox"> & { Sandbox: DurableObjectNamespace<SandboxControlWorker> }>

function diagnostic(error: unknown, env: Pick<Environment, "MONGOLGPT_RUNTIME_SECRET" | "EXPECTED_SDK_TOKEN">) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : "Unknown error"
  return message
    .replaceAll(env.EXPECTED_SDK_TOKEN, "[REDACTED]")
    .replaceAll(env.MONGOLGPT_RUNTIME_SECRET, "[REDACTED]")
    .slice(0, 500)
}

async function bounded<T>(work: Promise<T>, milliseconds: number, phase: string) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`probe ${phase} deadline`)), milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
