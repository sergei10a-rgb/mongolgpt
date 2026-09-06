import { describe, expect, test } from "bun:test"
import { QueryClient, QueryObserver } from "@tanstack/solid-query"
import { createMongolGPTClient, type Agent } from "@mongolgpt/sdk/v2/client"
import { loadAgentsQuery, loadProvidersQuery } from "@/context/global-sync/bootstrap"
import { ServerScope } from "@/utils/server-scope"
import { retryPromptBootstrap } from "@/pages/session/composer/session-composer-controls"

function sdkFor(input: { directory: string; response: () => Response | Promise<Response> }) {
  return createMongolGPTClient({
    baseUrl: "http://127.0.0.1:4356",
    directory: input.directory,
    throwOnError: true,
    fetch: Object.assign(async () => input.response(), { preconnect: () => {} }),
  })
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })
}

describe("retryPromptBootstrap isolation", () => {
  test("writes the captured A fetch into A after the active query switches to B", async () => {
    const agentsA: Agent[] = [{ name: "agent-a", mode: "primary", permission: [], options: {} }]
    const agentsB: Agent[] = [{ name: "agent-b", mode: "primary", permission: [], options: {} }]
    let releaseA!: () => void
    const aStarted = new Promise<void>((resolve) => {
      releaseA = resolve
    })
    const aSDK = sdkFor({
      directory: "/workspace-a",
      response: async () => {
        await aStarted
        return jsonResponse(agentsA)
      },
    })
    const bSDK = sdkFor({
      directory: "/workspace-b",
      response: () => jsonResponse(agentsB),
    })
    const queryClient = new QueryClient()
    const a = loadAgentsQuery(ServerScope.local, "/workspace-a", aSDK)
    const b = loadAgentsQuery(ServerScope.local, "/workspace-b", bSDK)
    let storedA: unknown
    const observer = new QueryObserver(queryClient, { ...a, enabled: false })
    const child = new QueryObserver(queryClient, { ...a, enabled: false })
    const unsubscribeChild = child.subscribe(() => {})
    const bObserved = new Promise<void>((resolve) => {
      observer.subscribe((result) => {
        if (result.data?.[0]?.name === "agent-b") resolve()
      })
    })

    try {
      const retry = retryPromptBootstrap({
        queryClient,
        agents: a,
        setAgents: (value) => {
          storedA = value
        },
      })
      observer.setOptions(b)
      await bObserved
      expect(observer.getCurrentResult().data).toEqual(agentsB)
      releaseA()
      await retry

      expect(storedA).toEqual(agentsA)
      expect(queryClient.getQueryData<Agent[]>(a.queryKey)).toEqual(agentsA)
      expect(queryClient.getQueryData<Agent[]>(b.queryKey)).toEqual(agentsB)
      expect(observer.getCurrentResult().data).toEqual(agentsB)
    } finally {
      unsubscribeChild()
      observer.destroy()
      queryClient.clear()
    }
  })

  test("does not write stale agents when the captured retry rejects", async () => {
    const sdk = sdkFor({
      directory: "/workspace-a",
      response: () => jsonResponse({ error: "temporary" }, 503),
    })
    const queryClient = new QueryClient()
    const a = loadAgentsQuery(ServerScope.local, "/workspace-a", sdk)
    let writes = 0

    try {
      await retryPromptBootstrap({
        queryClient,
        agents: a,
        setAgents: () => {
          writes++
        },
      })

      expect(writes).toBe(0)
      expect(queryClient.getQueryData(a.queryKey)).toBeUndefined()
    } finally {
      queryClient.clear()
    }
  })
})

describe("catalog query cancellation", () => {
  for (const kind of ["agents", "providers"] as const) {
    test(`${kind} forwards cancellation to the SDK instead of leaving an unbounded fetch`, async () => {
      let forwarded: AbortSignal | undefined
      let started: () => void = () => {}
      const ready = new Promise<void>((resolve) => {
        started = resolve
      })
      const sdk = createMongolGPTClient({
        baseUrl: "http://127.0.0.1:9",
        directory: "/workspace",
        fetch: Object.assign(
          async (input: RequestInfo | URL) => {
            const request = input instanceof Request ? input : new Request(input)
            forwarded = request.signal
            started()
            return new Promise<Response>(() => {})
          },
          { preconnect: () => {} },
        ),
      })
      const client = new QueryClient()
      try {
        const agents = loadAgentsQuery(ServerScope.local, "/workspace", sdk)
        const providers = loadProvidersQuery(ServerScope.local, "/workspace", sdk)
        const options = kind === "agents" ? agents : providers
        expect(options.retry).toBe(false)
        const settled = (kind === "agents" ? client.fetchQuery(agents) : client.fetchQuery(providers)).catch(
          () => undefined,
        )
        await ready
        await client.cancelQueries({ queryKey: options.queryKey })
        await settled
        expect(forwarded?.aborted).toBe(true)
        expect(client.getQueryData(options.queryKey)).toBeUndefined()
      } finally {
        client.clear()
      }
    })
  }
})
