import { describe, expect, test } from "bun:test"
import { staticAppBackendBoundaryPaths } from "../../app/src/utils/static-app-router"
import {
  inspectAccountOverviewPreflight,
  inspectAnonymousAccountOverview,
  inspectAnonymousRuntimeToken,
  inspectAnonymousRuntimeApiResponse,
  inspectForeignOriginRuntimeRejection,
  inspectHostedAuthorizeChallenge,
  inspectHostedAuthorizeRedirect,
  inspectHostedTurnstileRejection,
  inspectHostedTurnstileSuccess,
  inspectNoStoreResponse,
  inspectRuntimeTokenPreflight,
  inspectStaticAppBackendRejection,
  runAppSmoke,
  runAuthBootstrapSmoke,
  runDocsSmoke,
  runRuntimeSmoke,
} from "../../../script/deployment-smoke"
import {
  inspectDeploymentEndpointConfiguration,
  inspectDocsRootRedirect,
  inspectAuthenticatedAccountOverview,
  inspectAuthenticatedFreeAutoResponse,
  inspectAuthenticatedFreeAutoProvider,
  inspectAuthenticatedRuntimeProjects,
  inspectAuthenticatedRuntimeSession,
  inspectAuthenticatedRuntimeSessionCreate,
  inspectAuthenticatedRuntimeToken,
  inspectAuthHealth,
  inspectAdminProtection,
  inspectConsoleHealth,
  inspectAnonymousHostedSession,
  inspectAppHtml,
  inspectHtmlAssets,
  inspectHostedAppRuntime,
  inspectHostedAppRelease,
  inspectHtmlContentType,
  inspectJsonApiPayload,
  inspectPaymentHealth,
  inspectResponseOrigin,
  inspectRuntimeSessionCookie,
  inspectSmokeAuthCookie,
  inspectStaticAssetContentType,
  inspectRuntimeHealth,
} from "../src/deployment-smoke-contract"

const html = (meta: string) => `<!doctype html>
<html>
  <head>${meta}</head>
  <body><div id="root"></div><script type="module" src="/assets/index-abc123.js"></script></body>
</html>`

const appOrigin = "https://app.dev.mgpt.mn"

async function caught(promise: Promise<unknown>) {
  return promise.then(
    () => undefined,
    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  )
}

function mockedFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch {
  return Object.assign(handler, { preconnect: globalThis.fetch.preconnect })
}

const deployment = {
  stage: "dev",
  domain: "mgpt.mn",
  stageDomain: "dev.mgpt.mn",
  hostedServices: true,
  adminEnabled: false,
  backupsEnabled: false,
  monitoringEnabled: true,
  turnstileEnabled: true,
  paymentEnvironment: "disabled" as const,
  warnings: [],
}

describe("static app backend boundary", () => {
  test("requires a non-cacheable JSON 404 instead of the SPA shell", async () => {
    const response = Response.json(
      {
        code: "STATIC_APP_API_ROUTE",
        message: "MongolGPT веб аппын хаяг дээр API ажиллахгүй.",
      },
      {
        status: 404,
        headers: {
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      },
    )
    expect(await inspectStaticAppBackendRejection(response, "/api/health")).toBeUndefined()
  })

  test("rejects HTML, cacheable, and ambiguous error responses", async () => {
    const htmlResponse = new Response("<!doctype html><title>MongolGPT</title>", {
      status: 404,
      headers: {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
        "x-content-type-options": "nosniff",
      },
    })
    expect((await caught(inspectStaticAppBackendRejection(htmlResponse, "/api/health")))?.message).toContain("not JSON")

    const cacheable = Response.json(
      { code: "STATIC_APP_API_ROUTE" },
      { status: 404, headers: { "cache-control": "public", "x-content-type-options": "nosniff" } },
    )
    expect((await caught(inspectStaticAppBackendRejection(cacheable, "/global/health")))?.message).toContain(
      "cacheable",
    )

    const wrongCode = Response.json(
      { code: "NOT_FOUND" },
      { status: 404, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } },
    )
    expect((await caught(inspectStaticAppBackendRejection(wrongCode, "/v1/account/overview")))?.message).toContain(
      "wrong error contract",
    )
  })
})

describe("dev app-only smoke", () => {
  test("checks hosted provenance, assets, SPA navigation, and backend rejection without calling the runtime", async () => {
    const releaseSha = "a".repeat(40)
    const configured = {
      MONGOLGPT_DOMAIN: "mgpt.mn",
      MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
      MONGOLGPT_DEPLOY_APP_ONLY: "true",
      MONGOLGPT_ENABLE_ADMIN: "false",
      MONGOLGPT_ENABLE_ANALYTICS: "false",
      MONGOLGPT_ENABLE_D1_BACKUPS: "false",
      MONGOLGPT_ENABLE_BUSINESS_INTEGRATIONS: "false",
      MONGOLGPT_ENABLE_LEGACY_STRIPE: "false",
      MONGOLGPT_ENABLE_MONITORING: "false",
      MONGOLGPT_ENABLE_TURNSTILE: "false",
      MONGOLGPT_ENABLE_SHARE_SERVICE: "false",
      MONGOLGPT_ENABLE_SYNC_SERVICE: "false",
      MONGOLGPT_ENABLE_REAL_PAYMENTS: "false",
      MONGOLGPT_PAYMENT_ENVIRONMENT: "disabled",
      MONGOLGPT_RELEASE_SHA: releaseSha,
      MONGOLGPT_SMOKE_RETRIES: "1",
      MONGOLGPT_SMOKE_DELAY_MS: "1",
    } satisfies Record<string, string>
    const previous = new Map(Object.keys(configured).map((key) => [key, process.env[key]]))
    const originalFetch = globalThis.fetch
    const requests: string[] = []
    const boundaryPaths = new Set<string>(staticAppBackendBoundaryPaths)
    const document = html(`
      <title>MongolGPT</title>
      <meta name="mongolgpt-channel" content="dev">
      <meta name="mongolgpt-runtime-mode" content="hosted">
      <meta name="mongolgpt-server-url" content="https://runtime.dev.mgpt.mn">
      <meta name="mongolgpt-release-sha" content="${releaseSha}">
    `)

    Object.assign(process.env, configured)
    globalThis.fetch = mockedFetch(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input)
      requests.push(url.toString())
      if (url.pathname === "/" || url.pathname === "/new-session") {
        return new Response(document, { headers: { "content-type": "text/html; charset=utf-8" } })
      }
      if (url.pathname === "/assets/index-abc123.js") {
        return new Response("export {}", { headers: { "content-type": "text/javascript; charset=utf-8" } })
      }
      if (boundaryPaths.has(url.pathname)) {
        return Response.json(
          { code: "STATIC_APP_API_ROUTE", message: "MongolGPT веб аппын хаяг дээр API ажиллахгүй." },
          { status: 404, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } },
        )
      }
      throw new Error(`Unexpected app-only smoke request: ${url}`)
    })

    try {
      await runAppSmoke("dev")
    } finally {
      globalThis.fetch = originalFetch
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }

    expect(requests).toEqual([
      "https://app.dev.mgpt.mn/",
      "https://app.dev.mgpt.mn/assets/index-abc123.js",
      "https://app.dev.mgpt.mn/new-session",
      "https://app.dev.mgpt.mn/assets/index-abc123.js",
      ...staticAppBackendBoundaryPaths.map((path) => new URL(path, appOrigin).toString()),
    ])
  })
})

describe("dev runtime-only smoke", () => {
  test("checks health, authenticated origin CORS, and anonymous API rejection", async () => {
    const runtimePackage: unknown = await Bun.file(new URL("../../runtime/package.json", import.meta.url)).json()
    if (
      typeof runtimePackage !== "object" ||
      runtimePackage === null ||
      !("version" in runtimePackage) ||
      typeof runtimePackage.version !== "string"
    ) {
      throw new Error("runtime package version missing")
    }
    const configured = {
      MONGOLGPT_DOMAIN: "mgpt.mn",
      MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
      MONGOLGPT_ENABLE_ADMIN: "false",
      MONGOLGPT_ENABLE_ANALYTICS: "false",
      MONGOLGPT_ENABLE_D1_BACKUPS: "false",
      MONGOLGPT_ENABLE_BUSINESS_INTEGRATIONS: "false",
      MONGOLGPT_ENABLE_LEGACY_STRIPE: "false",
      MONGOLGPT_ENABLE_MONITORING: "false",
      MONGOLGPT_ENABLE_TURNSTILE: "false",
      MONGOLGPT_ENABLE_SHARE_SERVICE: "false",
      MONGOLGPT_ENABLE_SYNC_SERVICE: "false",
      MONGOLGPT_ENABLE_REAL_PAYMENTS: "false",
      MONGOLGPT_PAYMENT_ENVIRONMENT: "disabled",
      MONGOLGPT_SMOKE_RETRIES: "1",
      MONGOLGPT_SMOKE_DELAY_MS: "1",
    } satisfies Record<string, string>
    const previous = new Map(Object.keys(configured).map((key) => [key, process.env[key]]))
    const originalFetch = globalThis.fetch
    const requests: string[] = []

    Object.assign(process.env, configured)
    globalThis.fetch = mockedFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      requests.push(`${request.method} ${request.headers.get("origin") ?? "-"} ${url.toString()}`)
      if (url.pathname === "/global/health") {
        return Response.json(
          {
            healthy: true,
            service: "mongolgpt-runtime",
            stage: "dev",
            version: runtimePackage.version,
          },
          { headers: { "cache-control": "no-store" } },
        )
      }
      if (url.pathname === "/auth/session" && request.headers.get("origin") === "https://invalid-origin.example") {
        return Response.json(
          { error: "MongolGPT веб апп-аас хүсэлт илгээнэ үү." },
          {
            status: 403,
            headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
          },
        )
      }
      if (
        url.pathname === "/auth/session" ||
        url.pathname === "/project" ||
        url.pathname === "/provider" ||
        url.pathname === "/session" ||
        url.pathname.endsWith("/message")
      ) {
        return Response.json(
          url.pathname === "/auth/session" ? { authenticated: false } : { error: "Нэвтэрч орно уу." },
          {
            status: 401,
            headers: {
              "access-control-allow-origin": appOrigin,
              "access-control-allow-credentials": "true",
              "cache-control": "no-store",
            },
          },
        )
      }
      throw new Error(`Unexpected runtime-only smoke request: ${url}`)
    })

    try {
      await runRuntimeSmoke("dev")
    } finally {
      globalThis.fetch = originalFetch
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }

    expect(requests).toEqual([
      "GET - https://runtime.dev.mgpt.mn/global/health",
      `GET ${appOrigin} https://runtime.dev.mgpt.mn/auth/session`,
      "GET https://invalid-origin.example https://runtime.dev.mgpt.mn/auth/session",
      `GET ${appOrigin} https://runtime.dev.mgpt.mn/project`,
      `GET ${appOrigin} https://runtime.dev.mgpt.mn/provider`,
      `POST ${appOrigin} https://runtime.dev.mgpt.mn/session`,
      `POST ${appOrigin} https://runtime.dev.mgpt.mn/session/mongolgpt-anonymous-smoke/message`,
    ])
  })

  test("refuses non-dev and non-hosted runtime smoke before network access", async () => {
    expect((await caught(runRuntimeSmoke("production")))?.message).toContain("зөвхөн dev")
  })
})

describe("dev OAuth bootstrap smoke", () => {
  test("refuses every non-dev stage before making network requests", async () => {
    expect((await caught(runAuthBootstrapSmoke("production")))?.message).toContain("зөвхөн dev")
  })

  test("exercises the anonymous account and OAuth boundaries", async () => {
    const configured = {
      MONGOLGPT_DOMAIN: "mgpt.mn",
      MONGOLGPT_ENABLE_HOSTED_SERVICES: "true",
      MONGOLGPT_ENABLE_ADMIN: "false",
      MONGOLGPT_ENABLE_ANALYTICS: "false",
      MONGOLGPT_ENABLE_D1_BACKUPS: "false",
      MONGOLGPT_ENABLE_BUSINESS_INTEGRATIONS: "false",
      MONGOLGPT_ENABLE_LEGACY_STRIPE: "false",
      MONGOLGPT_ENABLE_MONITORING: "false",
      MONGOLGPT_ENABLE_TURNSTILE: "true",
      MONGOLGPT_TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
      MONGOLGPT_ENABLE_SHARE_SERVICE: "false",
      MONGOLGPT_ENABLE_SYNC_SERVICE: "false",
      MONGOLGPT_ENABLE_REAL_PAYMENTS: "false",
      MONGOLGPT_PAYMENT_ENVIRONMENT: "disabled",
      MONGOLGPT_AUTH_EMAIL_DOMAINS: "smoke@mgpt.mn",
      MONGOLGPT_SMOKE_RETRIES: "1",
      MONGOLGPT_SMOKE_DELAY_MS: "1",
    } satisfies Record<string, string>
    const previous = new Map(Object.keys(configured).map((key) => [key, process.env[key]]))
    const originalFetch = globalThis.fetch
    const requests: string[] = []

    const challenge = `<!doctype html>
      <html lang="mn"><head>
        <script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>
      </head><body>
        <form action="https://auth.dev.mgpt.mn/authorize" method="post">
          <input type="hidden" name="client_id" value="app">
          <input type="hidden" name="redirect_uri" value="https://dev.mgpt.mn/auth/callback/auth/app">
          <input type="hidden" name="response_type" value="code">
          <input type="hidden" name="state" value="12345678-1234-1234-1234-123456789012">
          <div data-sitekey="1x00000000000000000000AA" data-action="mongolgpt_login"></div>
        </form>
      </body></html>`

    Object.assign(process.env, configured)
    const mockFetch = mockedFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      const key = `${request.method} ${url.origin}${url.pathname}`
      requests.push(key)

      if (key === "GET https://dev.mgpt.mn/api/health") {
        return Response.json({ status: "ok", service: "console" }, { headers: { "cache-control": "no-store" } })
      }
      if (key === "GET https://auth.dev.mgpt.mn/health") {
        return Response.json({ status: "ok", service: "auth" }, { headers: { "cache-control": "no-store" } })
      }
      if (key === "GET https://dev.mgpt.mn/") {
        return new Response("<!doctype html><title>MongolGPT</title>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        })
      }
      if (key === "OPTIONS https://dev.mgpt.mn/auth/runtime-token") return preflightResponse()
      if (key === "POST https://dev.mgpt.mn/auth/runtime-token") return anonymousResponse()
      if (key === "OPTIONS https://dev.mgpt.mn/v1/account/overview") return accountOverviewPreflightResponse()
      if (key === "GET https://dev.mgpt.mn/v1/account/overview") return anonymousResponse()
      if (key === "GET https://dev.mgpt.mn/auth/authorize") {
        expect([...url.searchParams.entries()]).toEqual([["continue", "/auth/app"]])
        return new Response(challenge, {
          headers: {
            "cache-control": "no-store",
            "content-security-policy":
              "default-src 'none'; script-src https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; form-action https://auth.dev.mgpt.mn; object-src 'none'",
            "content-type": "text/html; charset=utf-8",
            "x-frame-options": "DENY",
          },
        })
      }
      if (key === "GET https://auth.dev.mgpt.mn/authorize") {
        expect([...url.searchParams.entries()]).toEqual([
          ["client_id", "app"],
          ["redirect_uri", "https://dev.mgpt.mn/auth/callback/auth/app"],
          ["response_type", "code"],
          ["state", "deployment-smoke-direct-auth"],
        ])
        return Response.json(
          {
            error: "turnstile_required",
            message: "Нэвтрэхийн өмнө Cloudflare Turnstile баталгаажуулалт шаардлагатай.",
          },
          { status: 403, headers: { "cache-control": "no-store" } },
        )
      }
      if (key === "POST https://auth.dev.mgpt.mn/authorize") {
        expect(request.headers.get("origin")).toBe("https://dev.mgpt.mn")
        const form = new URLSearchParams(await request.text())
        expect(form.get("cf-turnstile-response")).toBe("XXXX.DUMMY.TOKEN.XXXX")
        expect(form.get("client_id")).toBe("app")
        expect(form.get("redirect_uri")).toBe("https://dev.mgpt.mn/auth/callback/auth/app")
        expect(form.get("response_type")).toBe("code")
        expect(form.get("state")).toBe("12345678-1234-1234-1234-123456789012")
        return Response.redirect("https://github.com/login/oauth/authorize?client_id=public", 302)
      }
      throw new Error(`Unexpected bootstrap request: ${key}`)
    })
    globalThis.fetch = mockFetch

    try {
      await runAuthBootstrapSmoke("dev")
    } finally {
      globalThis.fetch = originalFetch
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }

    expect(requests).toEqual([
      "GET https://dev.mgpt.mn/api/health",
      "GET https://auth.dev.mgpt.mn/health",
      "GET https://dev.mgpt.mn/",
      "OPTIONS https://dev.mgpt.mn/auth/runtime-token",
      "POST https://dev.mgpt.mn/auth/runtime-token",
      "OPTIONS https://dev.mgpt.mn/v1/account/overview",
      "GET https://dev.mgpt.mn/v1/account/overview",
      "GET https://dev.mgpt.mn/auth/authorize",
      "GET https://auth.dev.mgpt.mn/authorize",
      "POST https://auth.dev.mgpt.mn/authorize",
    ])
  })
})

describe("dev docs-only smoke", () => {
  test("refuses production and hosted-service configuration", async () => {
    expect((await caught(runDocsSmoke("production")))?.message).toContain("зөвхөн dev")

    const previous = process.env.MONGOLGPT_ENABLE_HOSTED_SERVICES
    process.env.MONGOLGPT_ENABLE_HOSTED_SERVICES = "true"
    try {
      expect((await caught(runDocsSmoke("dev")))?.message).toContain("hosted service")
    } finally {
      if (previous === undefined) delete process.env.MONGOLGPT_ENABLE_HOSTED_SERVICES
      else process.env.MONGOLGPT_ENABLE_HOSTED_SERVICES = previous
    }
  })

  test("checks canonical docs, its asset, and the domain root redirect", async () => {
    const configured = {
      MONGOLGPT_DOMAIN: "mgpt.mn",
      MONGOLGPT_ENABLE_HOSTED_SERVICES: "false",
      MONGOLGPT_ENABLE_ADMIN: "false",
      MONGOLGPT_ENABLE_ANALYTICS: "false",
      MONGOLGPT_ENABLE_D1_BACKUPS: "false",
      MONGOLGPT_ENABLE_BUSINESS_INTEGRATIONS: "false",
      MONGOLGPT_ENABLE_LEGACY_STRIPE: "false",
      MONGOLGPT_ENABLE_MONITORING: "false",
      MONGOLGPT_ENABLE_TURNSTILE: "false",
      MONGOLGPT_ENABLE_SHARE_SERVICE: "false",
      MONGOLGPT_ENABLE_SYNC_SERVICE: "false",
      MONGOLGPT_ENABLE_REAL_PAYMENTS: "false",
      MONGOLGPT_PAYMENT_ENVIRONMENT: "disabled",
      MONGOLGPT_DEPLOY_DOCS_ONLY: "true",
      MONGOLGPT_SMOKE_RETRIES: "1",
      MONGOLGPT_SMOKE_DELAY_MS: "1",
    } satisfies Record<string, string>
    const previous = new Map(Object.keys(configured).map((key) => [key, process.env[key]]))
    const originalFetch = globalThis.fetch
    const requests: string[] = []

    Object.assign(process.env, configured)
    const mockFetch = mockedFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const url = new URL(request.url)
      requests.push(url.toString())
      if (url.toString() === "https://docs.dev.mgpt.mn/docs") {
        return new Response(
          '<!doctype html><html lang="mn"><head><link rel="stylesheet" href="/docs/_astro/docs.css"></head><body></body></html>',
          { headers: { "content-type": "text/html; charset=utf-8" } },
        )
      }
      if (url.toString() === "https://docs.dev.mgpt.mn/docs/_astro/docs.css") {
        return new Response("body { color: black; }", { headers: { "content-type": "text/css" } })
      }
      if (url.toString() === "https://docs.dev.mgpt.mn/") {
        return new Response(
          '<!doctype html><html lang="mn"><head><meta http-equiv="refresh" content="0;url=/docs/"><link rel="canonical" href="/docs/"></head></html>',
          { headers: { "content-type": "text/html; charset=utf-8" } },
        )
      }
      throw new Error(`Unexpected docs smoke request: ${url}`)
    })
    globalThis.fetch = mockFetch

    try {
      await runDocsSmoke("dev")
    } finally {
      globalThis.fetch = originalFetch
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }

    expect(requests).toEqual([
      "https://docs.dev.mgpt.mn/docs",
      "https://docs.dev.mgpt.mn/docs/_astro/docs.css",
      "https://docs.dev.mgpt.mn/",
    ])
  })
})

function corsHeaders() {
  return {
    "access-control-allow-origin": appOrigin,
    "access-control-allow-credentials": "true",
    "cache-control": "no-store",
    vary: "Origin",
  }
}

function preflightResponse(headers: Record<string, string> = {}) {
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(),
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "Content-Type, X-Org-ID",
      "access-control-max-age": "600",
      ...headers,
    },
  })
}

function anonymousResponse(
  body: unknown = { error: "unauthorized", message: "MongolGPT бүртгэлээр нэвтэрнэ үү." },
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status: 401,
    headers: { ...corsHeaders(), "content-type": "application/json", ...headers },
  })
}

function anonymousApiResponse(
  body: unknown = { error: "Нэвтэрч орно уу." },
  init: { status?: number; headers?: Record<string, string> } = {},
) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: init.status ?? 401,
    headers: { ...corsHeaders(), "content-type": "application/json", ...init.headers },
  })
}

function foreignOriginResponse(
  body: unknown = { error: "MongolGPT веб апп-аас хүсэлт илгээнэ үү." },
  init: { status?: number; headers?: Record<string, string> } = {},
) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: init.status ?? 403,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
      "x-content-type-options": "nosniff",
      ...init.headers,
    },
  })
}

function accountOverviewPreflightResponse(headers: Record<string, string> = {}) {
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(),
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "Authorization, X-Org-ID",
      "access-control-max-age": "600",
      ...headers,
    },
  })
}

const authenticatedOverview = {
  account: {
    id: "acc_smoke",
    email: "smoke@mgpt.mn",
    status: "active",
    createdAt: 1_700_000_000_000,
  },
  currentWorkspaceID: "wrk_smoke",
  workspaces: [
    {
      id: "wrk_smoke",
      name: "Smoke",
      slug: null,
      userID: "usr_smoke",
      role: "admin",
      subscription: null,
      limits: { plan: "free", promoTokens: 0, dailyRequests: 20, dailyRequestsFallback: 5 },
      quota: { status: "model-scoped", reason: "free-auto-model-limits" },
      usage: {},
    },
  ],
}

const authenticatedProviders = {
  all: [
    {
      id: "mongolgpt",
      name: "MongolGPT",
      models: {
        "free-auto": { id: "free-auto", name: "MongolGPT Free Auto" },
      },
    },
  ],
  default: { mongolgpt: "free-auto" },
  connected: ["mongolgpt"],
}

describe("inspectAppHtml", () => {
  test("accepts a branded local bridge build", () => {
    expect(
      inspectAppHtml(
        html(`
          <title>MongolGPT</title>
          <meta name="mongolgpt-channel" content="beta">
          <meta name="mongolgpt-runtime-mode" content="local-bridge">
          <meta name="mongolgpt-server-url" content="http://localhost:4096">
        `),
      ),
    ).toEqual({
      channel: "beta",
      mode: "local-bridge",
      serverUrl: "http://localhost:4096",
    })
  })

  test("rejects an app build without runtime metadata", () => {
    expect(() => inspectAppHtml(html("<title>MongolGPT</title>"))).toThrow("runtime")
  })

  test("rejects location-origin masquerading as a hosted API", () => {
    expect(() =>
      inspectAppHtml(
        html(`
          <title>MongolGPT</title>
          <meta name="mongolgpt-channel" content="beta">
          <meta name="mongolgpt-runtime-mode" content="hosted">
          <meta name="mongolgpt-server-url" content="https://app.dev.mgpt.mn">
        `),
        "https://app.dev.mgpt.mn",
      ),
    ).toThrow("static app origin")
  })

  test("requires the dev app channel and its dev runtime origin", () => {
    const contract = inspectAppHtml(
      html(`
        <title>MongolGPT</title>
        <meta name="mongolgpt-channel" content="dev">
        <meta name="mongolgpt-runtime-mode" content="hosted">
        <meta name="mongolgpt-server-url" content="https://runtime.dev.mgpt.mn">
      `),
      "https://app.dev.mgpt.mn",
    )

    expect(() =>
      inspectHostedAppRuntime(contract, {
        channel: "dev",
        runtimeHealthUrl: "https://runtime.dev.mgpt.mn/global/health",
      }),
    ).not.toThrow()
    expect(() =>
      inspectHostedAppRuntime(contract, {
        channel: "beta",
        runtimeHealthUrl: "https://runtime.dev.mgpt.mn/global/health",
      }),
    ).toThrow("expected beta")
    expect(() =>
      inspectHostedAppRuntime(contract, {
        channel: "dev",
        runtimeHealthUrl: "https://runtime.beta.mgpt.mn/global/health",
      }),
    ).toThrow("expected https://runtime.beta.mgpt.mn")
  })

  test("rejects a hosted runtime path, query, or fragment", () => {
    for (const serverUrl of [
      "https://runtime.dev.mgpt.mn/api",
      "https://runtime.dev.mgpt.mn?tenant=x",
      "https://runtime.dev.mgpt.mn#fragment",
    ]) {
      const contract = inspectAppHtml(
        html(`
          <title>MongolGPT</title>
          <meta name="mongolgpt-channel" content="dev">
          <meta name="mongolgpt-runtime-mode" content="hosted">
          <meta name="mongolgpt-server-url" content="${serverUrl}">
        `),
        "https://app.dev.mgpt.mn",
      )

      expect(() =>
        inspectHostedAppRuntime(contract, {
          channel: "dev",
          runtimeHealthUrl: "https://runtime.dev.mgpt.mn/global/health",
        }),
      ).toThrow("exact root URL")
    }
  })
})

describe("inspectHostedAppRelease", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567"

  test("accepts only the exact deployed Git revision", () => {
    expect(inspectHostedAppRelease(html(`<meta name="mongolgpt-release-sha" content="${sha}">`), sha)).toBe(sha)
  })

  test("rejects missing, malformed, and stale provenance", () => {
    expect(() => inspectHostedAppRelease(html(""), sha)).toThrow("missing")
    expect(() => inspectHostedAppRelease(html('<meta name="mongolgpt-release-sha" content="latest">'), sha)).toThrow(
      "invalid",
    )
    expect(() =>
      inspectHostedAppRelease(
        html('<meta name="mongolgpt-release-sha" content="fedcba9876543210fedcba9876543210fedcba98">'),
        sha,
      ),
    ).toThrow("expected")
  })
})

describe("inspectHtmlContentType", () => {
  test("accepts HTML media types with parameters", () => {
    expect(() => inspectHtmlContentType("text/html; charset=utf-8", "app response")).not.toThrow()
    expect(() => inspectHtmlContentType("text/html, text/html", "app response")).not.toThrow()
  })

  test("rejects a valid HTML body labelled as JSON", () => {
    expect(() => inspectHtmlContentType("application/json", "app response")).toThrow("not HTML")
    expect(() => inspectHtmlContentType("text/html, application/json", "app response")).toThrow("not HTML")
  })
})

describe("inspectJsonApiPayload", () => {
  test("rejects an HTML/static shell even when an endpoint returns HTTP 200", () => {
    expect(() =>
      inspectJsonApiPayload("text/html; charset=utf-8", "<!doctype html><html></html>", "runtime health"),
    ).toThrow("not JSON")
    expect(() => inspectJsonApiPayload("application/json", "<!doctype html><html></html>", "runtime health")).toThrow(
      "HTML/static shell",
    )
    expect(() => inspectJsonApiPayload("application/json", "MongolGPT static app", "runtime health")).toThrow(
      "not valid JSON",
    )
  })

  test("parses only application/json API bodies", () => {
    expect(inspectJsonApiPayload("application/json; charset=utf-8", '{"status":"ok"}', "console health")).toEqual({
      status: "ok",
    })
    expect(() => inspectJsonApiPayload("application/problem+json", '{"status":"ok"}', "console health")).toThrow(
      "not JSON",
    )
  })
})

describe("deployment endpoint configuration", () => {
  test("keeps dev API health separate from app and docs HTML routes", () => {
    expect(() =>
      inspectDeploymentEndpointConfiguration(
        {
          docs: "https://docs.dev.mgpt.mn/docs",
          app: appOrigin,
          console: "https://dev.mgpt.mn",
          consoleHealth: "https://dev.mgpt.mn/api/health",
          authHealth: "https://auth.dev.mgpt.mn/health",
          runtimeHealth: "https://runtime.dev.mgpt.mn/global/health",
          paymentHealth: "https://pay.dev.mgpt.mn/health",
        },
        deployment,
      ),
    ).not.toThrow()
  })

  test("fails clearly when a dev API endpoint points at the app or wrong domain", () => {
    expect(() =>
      inspectDeploymentEndpointConfiguration(
        {
          docs: "https://docs.dev.mgpt.mn/docs",
          app: appOrigin,
          console: appOrigin,
          consoleHealth: `${appOrigin}/api/health`,
          authHealth: "https://auth.dev.mgpt.mn/health",
          runtimeHealth: "https://runtime.dev.mgpt.mn/global/health",
          paymentHealth: "https://pay.dev.mgpt.mn/health",
        },
        deployment,
      ),
    ).toThrow("console endpoint is misconfigured for dev")
  })
})

describe("exact health contracts", () => {
  test("require the console and auth response shapes used by the actual handlers", () => {
    expect(inspectConsoleHealth({ status: "ok", service: "console" })).toEqual({
      status: "ok",
      service: "console",
    })
    expect(inspectAuthHealth({ status: "ok", service: "auth" })).toEqual({ status: "ok", service: "auth" })
    expect(() => inspectConsoleHealth({ status: "ok", service: "console", version: "1.2.3" })).toThrow(
      "unexpected shape",
    )
    expect(() => inspectConsoleHealth({ status: "ok", service: "auth" })).toThrow("not healthy")
    expect(() => inspectAuthHealth({ status: "ok" })).toThrow("unexpected shape")
    expect(() => inspectAuthHealth({ status: "ok", service: "console" })).toThrow("not healthy")
  })
})

describe("static asset contracts", () => {
  test("extracts every module script, stylesheet, and modulepreload reference", () => {
    expect(
      inspectHtmlAssets(
        `<!doctype html>
<html>
  <head>
    <link rel="modulepreload" href="/assets/runtime-a.js">
    <link rel="stylesheet" href="/assets/app.css">
    <script type="module" src="/assets/vendor.js"></script>
    <script type="module" src="/assets/main.js"></script>
  </head>
</html>`,
        appOrigin,
        "app response",
      ),
    ).toEqual([
      { kind: "modulepreload", url: `${appOrigin}/assets/runtime-a.js` },
      { kind: "stylesheet", url: `${appOrigin}/assets/app.css` },
      { kind: "script", url: `${appOrigin}/assets/vendor.js` },
      { kind: "script", url: `${appOrigin}/assets/main.js` },
    ])
  })

  test("validates static asset content types and rejects HTML shells", () => {
    expect(() =>
      inspectStaticAssetContentType(
        "text/css; charset=utf-8",
        { kind: "stylesheet", url: `${appOrigin}/assets/app.css` },
        "docs stylesheet",
      ),
    ).not.toThrow()
    expect(() =>
      inspectStaticAssetContentType(
        "text/css, text/css",
        { kind: "stylesheet", url: `${appOrigin}/assets/app.css` },
        "docs stylesheet",
      ),
    ).not.toThrow()
    expect(() =>
      inspectStaticAssetContentType(
        "application/javascript; charset=utf-8",
        { kind: "script", url: `${appOrigin}/assets/main.js` },
        "app module",
      ),
    ).not.toThrow()
    expect(() =>
      inspectStaticAssetContentType(
        "text/html; charset=utf-8",
        { kind: "modulepreload", url: `${appOrigin}/assets/runtime-a.js` },
        "app preload",
      ),
    ).toThrow("returned HTML")
    expect(() =>
      inspectStaticAssetContentType(
        "application/json",
        { kind: "stylesheet", url: `${appOrigin}/assets/app.css` },
        "docs stylesheet",
      ),
    ).toThrow("not CSS")
    expect(() =>
      inspectStaticAssetContentType(
        "text/css, text/html",
        { kind: "stylesheet", url: `${appOrigin}/assets/app.css` },
        "docs stylesheet",
      ),
    ).toThrow("conflicting content-type")
  })
})

describe("redirect origin contracts", () => {
  test("accepts only the canonical same-origin docs root target", () => {
    const docsUrl = "https://docs.dev.mgpt.mn/docs"
    const body =
      '<!doctype html><html lang="mn"><head><meta http-equiv="refresh" content="0;url=/docs/"><link rel="canonical" href="/docs/"></head></html>'

    expect(inspectDocsRootRedirect({ docsUrl, status: 200, contentType: "text/html; charset=utf-8", body })).toBe(
      "https://docs.dev.mgpt.mn/docs/",
    )
    expect(
      inspectDocsRootRedirect({
        docsUrl,
        status: 301,
        contentType: null,
        location: "/docs/",
        body: "",
      }),
    ).toBe("https://docs.dev.mgpt.mn/docs/")
    expect(() =>
      inspectDocsRootRedirect({
        docsUrl,
        status: 200,
        contentType: "text/html",
        body: body.replaceAll("/docs/", "https://example.com/docs/"),
      }),
    ).toThrow("target is invalid")
    expect(() =>
      inspectDocsRootRedirect({
        docsUrl,
        status: 302,
        contentType: null,
        location: "https://example.com/docs/",
        body: "",
      }),
    ).toThrow("target is invalid")
  })

  test("rejects a response that lands on the wrong host after redirect", () => {
    expect(
      inspectResponseOrigin({
        requestUrl: `${appOrigin}/docs`,
        responseUrl: `${appOrigin}/docs`,
        status: 200,
        label: "docs",
      }),
    ).toBeUndefined()

    expect(() =>
      inspectResponseOrigin({
        requestUrl: `${appOrigin}/docs`,
        responseUrl: "https://cdn.example.com/docs",
        status: 200,
        label: "docs",
      }),
    ).toThrow("left the expected origin")

    expect(() =>
      inspectResponseOrigin({
        requestUrl: `${appOrigin}/docs`,
        responseUrl: `${appOrigin}/docs`,
        status: 302,
        location: "https://cdn.example.com/docs",
        label: "docs",
      }),
    ).toThrow("redirect leaves")
  })

  test("accepts only a Cloudflare Access login redirect for the admin app", () => {
    expect(() =>
      inspectAdminProtection({
        requestUrl: "https://admin.dev.mgpt.mn",
        responseUrl: "https://admin.dev.mgpt.mn",
        status: 302,
        location: "https://mongolgpt.cloudflareaccess.com/cdn-cgi/access/login/admin.dev.mgpt.mn",
      }),
    ).not.toThrow()
    expect(() =>
      inspectAdminProtection({
        requestUrl: "https://admin.dev.mgpt.mn",
        responseUrl: "https://admin.dev.mgpt.mn",
        status: 302,
        location: "https://example.com/login",
      }),
    ).toThrow("Cloudflare Access")
    expect(() =>
      inspectAdminProtection({
        requestUrl: "https://admin.dev.mgpt.mn",
        responseUrl: "https://admin.dev.mgpt.mn",
        status: 200,
      }),
    ).toThrow("not protected")
  })
})

describe("hosted runtime token smoke contract", () => {
  test("requires the exact credentialed preflight contract", () => {
    expect(() => inspectRuntimeTokenPreflight(preflightResponse(), appOrigin)).not.toThrow()
    expect(() =>
      inspectRuntimeTokenPreflight(preflightResponse({ "access-control-allow-origin": "*" }), appOrigin),
    ).toThrow("CORS origin")
    expect(() =>
      inspectRuntimeTokenPreflight(preflightResponse({ "access-control-allow-methods": "POST" }), appOrigin),
    ).toThrow("methods")
  })

  test("requires an anonymous JSON 401 with no capability data", async () => {
    expect(await inspectAnonymousRuntimeToken(anonymousResponse(), appOrigin)).toBeUndefined()
    await expectFailure(
      inspectAnonymousRuntimeToken(anonymousResponse({ token: "must-not-exist" }), appOrigin),
      "fail-closed",
    )
    await expectFailure(
      inspectAnonymousRuntimeToken(
        anonymousResponse({ error: "unauthorized" }, { "content-type": "text/html" }),
        appOrigin,
      ),
      "not JSON",
    )
    await expectFailure(
      inspectAnonymousRuntimeToken(
        anonymousResponse({ error: "unauthorized" }, { "access-control-allow-origin": "*" }),
        appOrigin,
      ),
      "CORS origin",
    )
  })
})

describe("representative hosted runtime API smoke contract", () => {
  test("requires an anonymous JSON 401 from the runtime project route", async () => {
    expect(await inspectAnonymousRuntimeApiResponse(anonymousApiResponse(), appOrigin)).toBeUndefined()
    await expectFailure(
      inspectAnonymousRuntimeApiResponse(anonymousApiResponse({ error: "wrong" }), appOrigin),
      "fail-closed",
    )
  })

  test("rejects a static HTML shell from the runtime project route", async () => {
    await expectFailure(
      inspectAnonymousRuntimeApiResponse(
        anonymousApiResponse("<!doctype html><html><body>static app</body></html>", {
          headers: { "content-type": "text/html" },
        }),
        appOrigin,
      ),
      "not JSON",
    )
    await expectFailure(
      inspectAnonymousRuntimeApiResponse(anonymousApiResponse("<!doctype html>", { status: 200 }), appOrigin),
      "expected 401",
    )
  })
})

describe("foreign origin runtime rejection smoke contract", () => {
  test("requires an exact non-cacheable response without CORS access", async () => {
    expect(await inspectForeignOriginRuntimeRejection(foreignOriginResponse())).toBeUndefined()
    await expectFailure(
      inspectForeignOriginRuntimeRejection(
        foreignOriginResponse({ error: "MongolGPT веб апп-аас хүсэлт илгээнэ үү.", token: "must-not-exist" }),
      ),
      "fail-closed",
    )
    await expectFailure(
      inspectForeignOriginRuntimeRejection(
        foreignOriginResponse(undefined, { headers: { "access-control-allow-origin": "*" } }),
      ),
      "CORS access",
    )
    await expectFailure(
      inspectForeignOriginRuntimeRejection(
        foreignOriginResponse(undefined, { headers: { "cache-control": "public" } }),
      ),
      "cacheable",
    )
    await expectFailure(
      inspectForeignOriginRuntimeRejection(
        foreignOriginResponse(undefined, { headers: { "x-content-type-options": "" } }),
      ),
      "content sniffing",
    )
  })

  test("requires health and security-sensitive JSON responses to disable caching", () => {
    expect(() => inspectNoStoreResponse(foreignOriginResponse(), "runtime health response")).not.toThrow()
    expect(() =>
      inspectNoStoreResponse(
        foreignOriginResponse(undefined, { headers: { "cache-control": "max-age=0, private" } }),
        "runtime health response",
      ),
    ).toThrow("cacheable")
  })
})

describe("hosted account overview smoke contract", () => {
  test("requires the exact credentialed preflight contract", () => {
    expect(() => inspectAccountOverviewPreflight(accountOverviewPreflightResponse(), appOrigin)).not.toThrow()
    expect(() =>
      inspectAccountOverviewPreflight(
        accountOverviewPreflightResponse({ "access-control-allow-origin": "*" }),
        appOrigin,
      ),
    ).toThrow("CORS origin")
    expect(() =>
      inspectAccountOverviewPreflight(
        accountOverviewPreflightResponse({ "access-control-allow-methods": "GET" }),
        appOrigin,
      ),
    ).toThrow("methods")
  })

  test("requires an anonymous JSON 401 instead of a static app shell", async () => {
    expect(await inspectAnonymousAccountOverview(anonymousResponse(), appOrigin)).toBeUndefined()
    await expectFailure(
      inspectAnonymousAccountOverview(anonymousResponse({ error: "wrong" }), appOrigin),
      "fail-closed",
    )
    await expectFailure(
      inspectAnonymousAccountOverview(
        anonymousResponse("<!doctype html><html><body>static app</body></html>", {
          "content-type": "text/html",
        }),
        appOrigin,
      ),
      "not JSON",
    )
  })
})

describe("authenticated hosted Free Auto smoke contract", () => {
  const now = 1_800_000_000_000
  const expiresAt = now + 90_000
  const token = "runtime.header.signature"

  test("accepts only a host-only console session cookie without attributes", () => {
    const cookie = "__Host-mongolgpt-auth=opaque-session-value-123456"
    expect(inspectSmokeAuthCookie(cookie)).toBe(cookie)
    expect(() => inspectSmokeAuthCookie(undefined)).toThrow("дутуу")
    expect(() => inspectSmokeAuthCookie("auth=opaque-session-value-123456")).toThrow("__Host-mongolgpt-auth")
    expect(() => inspectSmokeAuthCookie(`${cookie}; Path=/`)).toThrow("зөвхөн cookie-ийн нэр")
    expect(() => inspectSmokeAuthCookie(`${cookie}\r\nX-Leak: yes`)).toThrow()
  })

  test("requires an active Free account with a current workspace", () => {
    expect(inspectAuthenticatedAccountOverview(authenticatedOverview)).toEqual({
      accountID: "acc_smoke",
      email: "smoke@mgpt.mn",
      workspaceID: "wrk_smoke",
    })
    expect(() =>
      inspectAuthenticatedAccountOverview({
        ...authenticatedOverview,
        workspaces: [
          {
            ...authenticatedOverview.workspaces[0],
            subscription: { id: "sub_paid" },
            limits: { plan: "basic" },
          },
        ],
      }),
    ).toThrow("Free plan")
    expect(() =>
      inspectAuthenticatedAccountOverview({ ...authenticatedOverview, currentWorkspaceID: "wrk_missing" }),
    ).toThrow("does not include")
  })

  test("binds the short-lived runtime capability and host-only cookie to the smoke account", () => {
    expect(
      inspectAuthenticatedRuntimeToken(
        { token, expiresAt, account: { id: "acc_smoke", email: "smoke@mgpt.mn" } },
        { accountID: "acc_smoke", email: "smoke@mgpt.mn" },
        now,
      ),
    ).toEqual({ token, expiresAt, accountID: "acc_smoke" })
    expect(() =>
      inspectAuthenticatedRuntimeToken(
        { token, expiresAt, account: { id: "acc_other", email: "smoke@mgpt.mn" } },
        { accountID: "acc_smoke", email: "smoke@mgpt.mn" },
        now,
      ),
    ).toThrow("does not match")
    expect(() =>
      inspectAuthenticatedRuntimeToken(
        { token, expiresAt: now + 126_000, account: { id: "acc_smoke", email: "smoke@mgpt.mn" } },
        { accountID: "acc_smoke", email: "smoke@mgpt.mn" },
        now,
      ),
    ).toThrow("expiry")

    const setCookie = `__Host-mongolgpt-runtime=${token}; Max-Age=90; Path=/; Secure; HttpOnly; SameSite=Strict`
    expect(inspectRuntimeSessionCookie(setCookie, token)).toBe(`__Host-mongolgpt-runtime=${token}`)
    expect(() => inspectRuntimeSessionCookie(`${setCookie}; Domain=mgpt.mn`, token)).toThrow("host-only")
  })

  test("requires the runtime session to keep the same account and expiry", () => {
    expect(
      inspectAuthenticatedRuntimeSession(
        { authenticated: true, account: { id: "acc_smoke" }, expiresAt },
        { accountID: "acc_smoke", maximumExpiresAt: expiresAt },
        now,
      ),
    ).toEqual({ authenticated: true, accountID: "acc_smoke", expiresAt })
    expect(() =>
      inspectAuthenticatedRuntimeSession(
        { authenticated: true, account: { id: "acc_other" }, expiresAt },
        { accountID: "acc_smoke", maximumExpiresAt: expiresAt },
        now,
      ),
    ).toThrow("does not match")
  })

  test("requires a real project API array and the rebranded Free Auto provider", () => {
    expect(inspectAuthenticatedRuntimeProjects([])).toBe(0)
    expect(inspectAuthenticatedRuntimeProjects([{ id: "project_smoke" }])).toBe(1)
    expect(() => inspectAuthenticatedRuntimeProjects("<!doctype html>")).toThrow("not an array")
    expect(inspectAuthenticatedFreeAutoProvider(authenticatedProviders)).toEqual({
      providerID: "mongolgpt",
      modelID: "free-auto",
    })
    expect(() =>
      inspectAuthenticatedFreeAutoProvider({
        ...authenticatedProviders,
        all: [{ id: "opencode", name: "OpenCode", models: {} }],
      }),
    ).toThrow("legacy")
    expect(() =>
      inspectAuthenticatedFreeAutoProvider({
        ...authenticatedProviders,
        all: [{ id: "mongolgpt", name: "MongolGPT", models: {} }],
      }),
    ).toThrow("Free Auto")
    expect(() => inspectAuthenticatedFreeAutoProvider({ ...authenticatedProviders, connected: [] })).toThrow(
      "not connected",
    )
  })

  test("requires a real isolated session and an authenticated Free Auto model response", () => {
    expect(inspectAuthenticatedRuntimeSessionCreate({ id: "ses_smoke", directory: "/workspace" })).toEqual({
      sessionID: "ses_smoke",
    })
    expect(() => inspectAuthenticatedRuntimeSessionCreate({ id: "ses_smoke", directory: "C:\\Users\\owner" })).toThrow(
      "isolated workspace",
    )

    const response = {
      info: {
        id: "msg_smoke",
        sessionID: "ses_smoke",
        role: "assistant",
        providerID: "mongolgpt",
        modelID: "free-auto",
        time: { created: 1, completed: 2 },
        cost: 0,
        tokens: { input: 8, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "stop",
      },
      parts: [
        {
          id: "prt_smoke",
          sessionID: "ses_smoke",
          messageID: "msg_smoke",
          type: "text",
          text: "MONGOLGPT_SMOKE_READY",
        },
      ],
    }
    expect(inspectAuthenticatedFreeAutoResponse(response, "ses_smoke")).toEqual({
      providerID: "mongolgpt",
      modelID: "free-auto",
      output: "MONGOLGPT_SMOKE_READY",
    })
    expect(() =>
      inspectAuthenticatedFreeAutoResponse(
        { ...response, info: { ...response.info, providerID: "opencode" } },
        "ses_smoke",
      ),
    ).toThrow("identity")
    expect(() =>
      inspectAuthenticatedFreeAutoResponse(
        { ...response, parts: [{ ...response.parts[0], text: "өөр хариу" }] },
        "ses_smoke",
      ),
    ).toThrow("smoke marker")
    expect(() =>
      inspectAuthenticatedFreeAutoResponse(
        { ...response, info: { ...response.info, tokens: { ...response.info.tokens, output: 0 } } },
        "ses_smoke",
      ),
    ).toThrow("usage evidence")
  })
})

describe("hosted authorization smoke contract", () => {
  const requestUrl = "https://dev.mgpt.mn/auth/authorize?continue=/auth/app"
  const authOrigin = "https://auth.dev.mgpt.mn"
  const callback = "https://dev.mgpt.mn/auth/callback/auth/app"
  const location = `${authOrigin}/authorize?client_id=app&redirect_uri=${encodeURIComponent(callback)}`

  const challenge = `<!doctype html>
    <html lang="mn"><head>
      <script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>
    </head><body>
      <form action="https://auth.dev.mgpt.mn/authorize" method="post">
        <input type="hidden" name="client_id" value="app">
        <input type="hidden" name="redirect_uri" value="https://dev.mgpt.mn/auth/callback/auth/app">
        <input type="hidden" name="response_type" value="code">
        <input type="hidden" name="state" value="12345678-1234-1234-1234-123456789012">
        <div data-sitekey="1x00000000000000000000AA" data-action="mongolgpt_login"></div>
      </form>
    </body></html>`
  const challengeInput = {
    requestUrl,
    authOrigin,
    responseUrl: requestUrl,
    status: 200,
    contentType: "text/html; charset=utf-8",
    cacheControl: "no-store",
    contentSecurityPolicy:
      "default-src 'none'; script-src https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; form-action https://auth.dev.mgpt.mn; object-src 'none'",
    frameOptions: "DENY",
    body: challenge,
  }

  test("requires a local Mongolian Turnstile challenge when protection is enabled", () => {
    expect(() => inspectHostedAuthorizeChallenge(challengeInput)).not.toThrow()
    expect(() => inspectHostedAuthorizeChallenge({ ...challengeInput, status: 302, location })).toThrow(
      "expected a local HTML challenge",
    )
    expect(() =>
      inspectHostedAuthorizeChallenge({ ...challengeInput, body: challenge.replace("mongolgpt_login", "other") }),
    ).toThrow("action is invalid")
    expect(() =>
      inspectHostedAuthorizeChallenge({ ...challengeInput, body: challenge.replace('value="app"', 'value="other"') }),
    ).toThrow("client ID is invalid")
    expect(() =>
      inspectHostedAuthorizeChallenge({
        ...challengeInput,
        body: challenge.replace(
          '<input type="hidden" name="client_id" value="app">',
          '<input type="hidden" name="client_id" value="app"><input name="client_id" value="other">',
        ),
      }),
    ).toThrow("client ID is invalid")
    expect(() =>
      inspectHostedAuthorizeChallenge({
        ...challengeInput,
        body: challenge.replace(callback, "https://example.com/callback"),
      }),
    ).toThrow("callback is invalid")
    expect(() =>
      inspectHostedAuthorizeChallenge({ ...challengeInput, body: challenge.replace('value="code"', 'value="token"') }),
    ).toThrow("response type is invalid")
    expect(() =>
      inspectHostedAuthorizeChallenge({
        ...challengeInput,
        body: challenge.replace("12345678-1234-1234-1234-123456789012", "short"),
      }),
    ).toThrow("state is invalid")
    expect(() =>
      inspectHostedAuthorizeChallenge({
        ...challengeInput,
        contentSecurityPolicy: "default-src 'self'",
      }),
    ).toThrow("CSP is missing")
  })

  test("rejects direct auth worker authorization without a Turnstile token", () => {
    const direct = {
      requestUrl: `${authOrigin}/authorize?client_id=app&redirect_uri=${encodeURIComponent(callback)}&response_type=code&state=direct`,
      responseUrl: `${authOrigin}/authorize`,
      status: 403,
      cacheControl: "no-store",
      body: {
        error: "turnstile_required",
        message: "Нэвтрэхийн өмнө Cloudflare Turnstile баталгаажуулалт шаардлагатай.",
      },
    }
    expect(() => inspectHostedTurnstileRejection(direct)).not.toThrow()
    expect(() => inspectHostedTurnstileRejection({ ...direct, status: 302, location })).toThrow("expected 403")
    expect(() => inspectHostedTurnstileRejection({ ...direct, body: { error: "other" } })).toThrow("shape")
  })

  test("requires a valid test-token path to reach a real OAuth provider", () => {
    const success = {
      requestUrl: `${authOrigin}/authorize`,
      responseUrl: `${authOrigin}/authorize`,
      status: 302,
      location: "https://github.com/login/oauth/authorize?client_id=public",
      body: "",
      consoleOrigin: "https://dev.mgpt.mn",
      authOrigin,
    }
    expect(() => inspectHostedTurnstileSuccess(success)).not.toThrow()
    expect(() =>
      inspectHostedTurnstileSuccess({
        ...success,
        status: 200,
        location: undefined,
        contentType: "text/html; charset=utf-8",
        body: "<html><body>Continue with GitHub</body></html>",
      }),
    ).not.toThrow()
    expect(() => inspectHostedTurnstileSuccess({ ...success, status: 503, location: undefined })).toThrow("HTTP 503")
    expect(() =>
      inspectHostedTurnstileSuccess({
        ...success,
        status: 303,
        location: "https://dev.mgpt.mn/auth/authorize?turnstile_error=invalid",
      }),
    ).toThrow("challenge with an error")
    expect(() =>
      inspectHostedTurnstileSuccess({ ...success, location: "https://example.com/oauth" }),
    ).toThrow("unexpected origin")
  })

  test("requires the console to redirect to the dedicated auth worker when Turnstile is disabled", () => {
    expect(() =>
      inspectHostedAuthorizeRedirect({
        requestUrl,
        responseUrl: requestUrl,
        status: 302,
        location,
        authOrigin,
      }),
    ).not.toThrow()
    expect(() =>
      inspectHostedAuthorizeRedirect({
        requestUrl,
        responseUrl: requestUrl,
        status: 200,
        authOrigin,
      }),
    ).toThrow("expected a redirect")
  })

  test("rejects static-app and foreign authorization redirects", () => {
    expect(() =>
      inspectHostedAuthorizeRedirect({
        requestUrl,
        responseUrl: requestUrl,
        status: 302,
        location: `https://app.dev.mgpt.mn/authorize?client_id=app&redirect_uri=${encodeURIComponent(callback)}`,
        authOrigin,
      }),
    ).toThrow("auth worker")
    expect(() =>
      inspectHostedAuthorizeRedirect({
        requestUrl,
        responseUrl: requestUrl,
        status: 302,
        location: `https://example.com/authorize?client_id=app&redirect_uri=${encodeURIComponent(callback)}`,
        authOrigin,
      }),
    ).toThrow("auth worker")
  })

  test("requires the fixed host-only app callback", () => {
    expect(() =>
      inspectHostedAuthorizeRedirect({
        requestUrl,
        responseUrl: requestUrl,
        status: 302,
        location: `${authOrigin}/authorize?client_id=app&redirect_uri=${encodeURIComponent("https://example.com/callback")}`,
        authOrigin,
      }),
    ).toThrow("callback is invalid")
  })
})

async function expectFailure(result: Promise<unknown>, message: string) {
  try {
    await result
  } catch (error) {
    if (!(error instanceof Error)) throw error
    expect(error.message).toContain(message)
    return
  }
  throw new Error(`Expected failure containing: ${message}`)
}

describe("inspectAnonymousHostedSession", () => {
  test("accepts only a fail-closed anonymous session", () => {
    expect(inspectAnonymousHostedSession({ authenticated: false })).toEqual({ authenticated: false })
    expect(() => inspectAnonymousHostedSession("<html>not an API</html>")).toThrow("not an object")
    expect(() =>
      inspectAnonymousHostedSession({
        authenticated: true,
        account: { id: "leaked" },
      }),
    ).toThrow("not anonymous")
    expect(() =>
      inspectAnonymousHostedSession({
        authenticated: false,
        account: { id: "leaked" },
      }),
    ).toThrow("exposed account")
  })
})

describe("inspectRuntimeHealth", () => {
  test("requires the deployed runtime stage and version to match exactly", () => {
    const health = {
      healthy: true,
      service: "mongolgpt-runtime",
      stage: "dev",
      version: "0.1.1",
    } as const
    expect(inspectRuntimeHealth(health, { stage: "dev", version: "0.1.1" })).toEqual(health)
    expect(() => inspectRuntimeHealth(health, { stage: "production", version: "0.1.1" })).toThrow("expected production")
    expect(() => inspectRuntimeHealth(health, { stage: "dev", version: "0.1.2" })).toThrow("expected 0.1.2")
  })
})

describe("inspectPaymentHealth", () => {
  test("accepts a fully disabled payment service", () => {
    expect(
      inspectPaymentHealth(
        {
          status: "disabled",
          service: "payments",
          environment: "disabled",
          providers: { qpay: false, bonum: false },
          catalog: false,
          checkout: false,
          cancellation: false,
          refund: false,
        },
        "disabled",
      ),
    ).toEqual({ status: "disabled", environment: "disabled" })
  })

  test("accepts a fully ready sandbox service", () => {
    expect(
      inspectPaymentHealth(
        {
          status: "ok",
          service: "payments",
          environment: "sandbox",
          providers: { qpay: true, bonum: true },
          catalog: true,
          checkout: true,
          cancellation: true,
          refund: true,
        },
        "sandbox",
      ),
    ).toEqual({ status: "ok", environment: "sandbox" })
  })

  test("rejects degraded, mismatched, or accidentally enabled payment state", () => {
    expect(() =>
      inspectPaymentHealth(
        {
          status: "degraded",
          service: "payments",
          environment: "sandbox",
          providers: { qpay: true, bonum: false },
          catalog: true,
          checkout: false,
          cancellation: true,
          refund: true,
        },
        "sandbox",
      ),
    ).toThrow("not fully ready")

    expect(() =>
      inspectPaymentHealth(
        {
          status: "ok",
          service: "payments",
          environment: "sandbox",
          providers: { qpay: true, bonum: true },
          catalog: true,
          checkout: true,
          cancellation: true,
          refund: true,
        },
        "production",
      ),
    ).toThrow("expected production")

    expect(() =>
      inspectPaymentHealth(
        {
          status: "disabled",
          service: "payments",
          environment: "disabled",
          providers: { qpay: true, bonum: false },
          catalog: false,
          checkout: false,
          cancellation: false,
          refund: false,
        },
        "disabled",
      ),
    ).toThrow("enabled capability")
  })
})
