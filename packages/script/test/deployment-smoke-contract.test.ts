import { describe, expect, test } from "bun:test"
import { inspectAnonymousHostedSession, inspectAppHtml, inspectPaymentHealth } from "../src/deployment-smoke-contract"

const html = (meta: string) => `<!doctype html>
<html>
  <head>${meta}</head>
  <body><div id="root"></div><script type="module" src="/assets/index-abc123.js"></script></body>
</html>`

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
})

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
