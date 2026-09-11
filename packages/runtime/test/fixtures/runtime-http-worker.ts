import { getSandbox } from "@cloudflare/sandbox"
import { MongolGPTSandbox } from "../../src/index"
import { runtimeReadiness, waitForRestoredRuntimeReadiness } from "../../src/runtime"
import { fetchRuntime, runtimeHttpHeader } from "../../src/runtime-http"

export { ContainerProxy } from "../../src/index"

// A real DO/RPC boundary, with only the VM TCP endpoint replaced by a fixed response.
export class NativeEndpoint extends MongolGPTSandbox {
  #invocations = 0
  #healthFailures = 0
  #healthStalls = 0
  #healthAborts = 0

  constructor(ctx: DurableObjectState<{}>, env: ConstructorParameters<typeof MongolGPTSandbox>[1]) {
    Object.defineProperty(ctx, "container", { value: { running: false } })
    super(ctx, env)
  }

  async invocations() {
    return this.#invocations
  }

  async healthFailures(count: number) {
    this.#healthFailures = count
  }

  async healthStalls(count: number) {
    this.#healthStalls = count
    this.#healthAborts = 0
  }

  async healthAborts() {
    return this.#healthAborts
  }

  override async containerFetch(...args: Parameters<MongolGPTSandbox["containerFetch"]>): Promise<Response> {
    const request = args[0]
    const port = typeof args[1] === "number" ? args[1] : args[2]
    this.#invocations++
    if (!(request instanceof Request) || port !== 4096 || request.headers.has(runtimeHttpHeader))
      throw new Error("Invalid fixture routing")
    if (request.headers.get("authorization") !== `Basic ${btoa("mongolgpt:test")}`)
      return new Response(null, { status: 401 })
    if (new URL(request.url).pathname !== "/global/health") {
      return Response.json({ method: request.method, body: await request.text(), url: request.url })
    }
    if (this.#healthStalls > 0) {
      this.#healthStalls--
      return new Promise<Response>((_, reject) => {
        const abort = () => {
          this.#healthAborts++
          reject(request.signal.reason)
        }
        if (request.signal.aborted) return abort()
        request.signal.addEventListener("abort", abort, { once: true })
      })
    }
    if (this.#healthFailures > 0) {
      this.#healthFailures--
      return new Response("synthetic-temporary-health-error", { status: 500 })
    }
    return Response.json(
      { healthy: true, version: "fixture" },
      {
        headers: {
          "x-mongolgpt-runtime-history": "checkpoint-v1",
          "x-mongolgpt-runtime-isolation": "cgroup-v1",
          "x-mongolgpt-runtime-publication": "tool-pty-v1",
        },
      },
    )
  }
}

NativeEndpoint.outboundHandlers = MongolGPTSandbox.outboundHandlers!

export default {
  async fetch(request: Request, env: { Native: DurableObjectNamespace<NativeEndpoint> }) {
    const sandbox = getSandbox(env.Native as unknown as DurableObjectNamespace<MongolGPTSandbox>, "native-http", {
      normalizeId: true,
      sleepAfter: "10m",
      transport: "rpc",
    })
    const pathname = new URL(request.url).pathname
    if (pathname === "/retry-stalled-health") {
      const endpoint = env.Native.get(env.Native.idFromName("native-http"))
      await endpoint.healthStalls(1)
      const before = await endpoint.invocations()
      const readiness = await waitForRestoredRuntimeReadiness(
        {
          containerFetch: (request, port) => fetchRuntime(sandbox, request, port),
          probeReadiness: (password, restored, timeoutMs) => sandbox.probeReadiness(password, restored, timeoutMs),
        },
        "test",
        8_000,
      )
      const response =
        readiness.code === "ready"
          ? await fetchRuntime(
              sandbox,
              new Request("http://localhost/session", {
                method: "POST",
                headers: { authorization: `Basic ${btoa("mongolgpt:test")}` },
                body: "one-mutation-after-recovery",
              }),
              4096,
            )
          : undefined
      return Response.json({
        readiness,
        invocations: (await endpoint.invocations()) - before,
        aborted: await endpoint.healthAborts(),
        mutation: await response?.json(),
      })
    }
    if (pathname === "/retry-health" || pathname === "/retry-deadline") {
      const endpoint = env.Native.get(env.Native.idFromName("native-http"))
      await endpoint.healthFailures(pathname === "/retry-health" ? 1 : 100)
      const before = await endpoint.invocations()
      const started = performance.now()
      const readiness = await waitForRestoredRuntimeReadiness(
        { containerFetch: (request, port) => fetchRuntime(sandbox, request, port) },
        "test",
        pathname === "/retry-health" ? 2_000 : 550,
      )
      const elapsed = performance.now() - started
      const invocations = (await endpoint.invocations()) - before
      await endpoint.healthFailures(0)
      return Response.json({ readiness, invocations, elapsed })
    }
    if (pathname === "/legacy")
      return Response.json(
        await runtimeReadiness(
          { containerFetch: (request, port) => sandbox.containerFetch(request, port) },
          "test",
          true,
        ),
      )
    if (pathname === "/health")
      return Response.json(
        await runtimeReadiness(
          {
            containerFetch: (request, port) => fetchRuntime(sandbox, request, port),
          },
          "test",
          true,
        ),
      )
    if (pathname === "/invalid-marker")
      return sandbox.fetch(
        new Request("http://localhost/global/health", {
          headers: { [runtimeHttpHeader]: "v2" },
        }),
      )
    const controller = new AbortController()
    if (pathname === "/aborted") controller.abort()
    const endpoint = env.Native.get(env.Native.idFromName("native-http"))
    const before = await endpoint.invocations()
    try {
      return await fetchRuntime(
        sandbox,
        new Request("http://localhost/session?directory=%2Fworkspace", {
          method: "POST",
          headers: { authorization: `Basic ${btoa("mongolgpt:test")}` },
          body: "synthetic-request-body",
          signal: controller.signal,
          redirect: "manual",
        }),
        4096,
      )
    } catch (error) {
      return Response.json(
        {
          name: error instanceof Error ? error.name : "unknown",
          executed: (await endpoint.invocations()) !== before,
        },
        { status: 502 },
      )
    }
  },
}
