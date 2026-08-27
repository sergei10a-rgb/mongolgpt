import { describe, expect, test } from "bun:test"
import {
  inspectAccountOverviewPreflight,
  inspectAnonymousAccountOverview,
  inspectAnonymousRuntimeToken,
  inspectAnonymousRuntimeApiResponse,
  inspectForeignOriginRuntimeRejection,
  inspectHostedAuthorizeChallenge,
  inspectHostedAuthorizeRedirect,
  inspectHostedTurnstileRejection,
  inspectNoStoreResponse,
  inspectRuntimeTokenPreflight,
} from "../../../script/deployment-smoke"
import {
  inspectDeploymentEndpointConfiguration,
  inspectAuthHealth,
  inspectAdminProtection,
  inspectConsoleHealth,
  inspectAnonymousHostedSession,
  inspectAppHtml,
  inspectHtmlAssets,
  inspectHostedAppRuntime,
  inspectHtmlContentType,
  inspectJsonApiPayload,
  inspectPaymentHealth,
  inspectResponseOrigin,
  inspectStaticAssetContentType,
  inspectRuntimeHealth,
} from "../src/deployment-smoke-contract"

const html = (meta: string) => `<!doctype html>
<html>
  <head>${meta}</head>
  <body><div id="root"></div><script type="module" src="/assets/index-abc123.js"></script></body>
</html>`

const appOrigin = "https://app.dev.mgpt.mn"

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
      "access-control-allow-headers": "Content-Type",
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
        },
        "disabled",
      ),
    ).toThrow("enabled capability")
  })
})
