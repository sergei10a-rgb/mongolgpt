import { describe, expect, test } from "bun:test"
import { inspectAppHtml } from "../src/deployment-smoke-contract"

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
