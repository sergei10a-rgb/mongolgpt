import { expect, test } from "bun:test"
import { inspectAppHtml } from "../src/deployment-smoke-contract"

function html(origin: string, channel = "dev", preview = "true") {
  return `<title>MongolGPT</title><div id="root"></div><script type="module" src="/assets/app.js"></script>
    <meta name="mongolgpt-runtime-mode" content="hosted"><meta name="mongolgpt-channel" content="${channel}">
    <meta name="mongolgpt-server-url" content="${origin}"><meta name="mongolgpt-owner-preview" content="${preview}">`
}
test("same-origin artifact exception is restricted to marked dev preview", () => {
  const origin = "https://preview.dev.mgpt.mn"
  expect(inspectAppHtml(html(origin), origin).serverUrl).toBe(origin)
  for (const other of ["https://app.dev.mgpt.mn", "https://app.mgpt.mn", "https://evil.example"]) {
    expect(() => inspectAppHtml(html(other), other)).toThrow("static app origin")
  }
  expect(() => inspectAppHtml(html(origin, "prod"), origin)).toThrow("static app origin")
  expect(() => inspectAppHtml(html(origin, "dev", "false"), origin)).toThrow("static app origin")
})
