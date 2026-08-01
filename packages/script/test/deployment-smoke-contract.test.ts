import { describe, expect, test } from "bun:test"
import { inspectAnonymousRuntimeToken, inspectRuntimeTokenPreflight } from "../../../script/deployment-smoke"
import {
  inspectAnonymousHostedSession,
  inspectAppHtml,
  inspectHostedAppRuntime,
  inspectJsonApiPayload,
  inspectPaymentHealth,
} from "../src/deployment-smoke-contract"

const html = (meta: string) => `<!doctype html>
<html>
  <head>${meta}</head>
  <body><div id="root"></div><script type="module" src="/assets/index-abc123.js"></script></body>
</html>`

const appOrigin = "https://app.dev.mgpt.mn"

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
