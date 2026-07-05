import { describe, expect, test } from "bun:test"
import { OAUTH_DUMMY_KEY } from "../../src/auth"
import { MongolGPTAuthPlugin } from "../../src/plugin/mongolgpt"

function makeInput() {
  const setCalls: Array<Record<string, unknown>> = []
  return {
    input: {
      client: {
        auth: {
          set: async (req: Record<string, unknown>) => {
            setCalls.push(req)
          },
        },
      },
    } as any,
    setCalls,
  }
}

function makeServer(handler: (request: Request, url: URL) => Response | Promise<Response>) {
  return Bun.serve({
    port: 0,
    fetch: (request) => handler(request, new URL(request.url)),
  })
}

describe("plugin.mongolgpt", () => {
  test("exposes MongolGPT account OAuth before service account API key", async () => {
    const hooks = await MongolGPTAuthPlugin({} as any)

    expect(hooks.auth?.provider).toBe("mongolgpt")
    expect(hooks.auth?.methods.map((method) => [method.type, method.label])).toEqual([
      ["oauth", "MongolGPT аккаунтаар нэвтрэх"],
      ["api", "API key (service account)"],
    ])
  })

  test("returns no loader options unless stored auth is OAuth", async () => {
    const hooks = await MongolGPTAuthPlugin({} as any)

    expect(await hooks.auth!.loader!(async () => ({ type: "api", key: "sk-test" }), {} as any)).toEqual({})
    expect(
      await hooks.auth!.loader!(async () => ({ type: "wellknown", key: "k", token: "t" }) as any, {} as any),
    ).toEqual({})
  })

  test("replaces the dummy bearer with the MongolGPT account access token", async () => {
    const { input } = makeInput()
    const captured: Headers[] = []
    using server = makeServer((request) => {
      captured.push(request.headers)
      return new Response("{}", { status: 200 })
    })

    const hooks = await MongolGPTAuthPlugin(input)
    const opts = await hooks.auth!.loader!(
      async () => ({
        type: "oauth",
        access: "account-token",
        refresh: "refresh-token",
        expires: Date.now() + 3600_000,
      }),
      {} as any,
    )

    expect(opts.apiKey).toBe(OAUTH_DUMMY_KEY)
    await opts.fetch!(new URL("/zen/v1/chat/completions", server.url), {
      headers: { Authorization: `Bearer ${OAUTH_DUMMY_KEY}`, "x-keep": "yes" },
    })

    expect(captured[0].get("authorization")).toBe("Bearer account-token")
    expect(captured[0].get("x-keep")).toBe("yes")
    expect(captured[0].get("user-agent")).toMatch(/^mongolgpt\//)
  })
})
