import { describe, expect, test } from "bun:test"
import { verifyHostedWebArtifact } from "../../../script/verify-hosted-web-artifact"

function artifact(input: { mode: "local-bridge" | "hosted"; channel: "dev" | "beta" | "prod"; serverUrl: string }) {
  return `<!doctype html>
<html lang="mn">
  <head>
    <title>MongolGPT</title>
    <meta name="mongolgpt-channel" content="${input.channel}">
    <meta name="mongolgpt-runtime-mode" content="${input.mode}">
    <meta name="mongolgpt-server-url" content="${input.serverUrl}">
    <script type="module" src="/assets/app.js"></script>
  </head>
  <body><div id="root"></div></body>
</html>`
}

describe("hosted web artifact gate", () => {
  test("accepts the exact dev channel and runtime origin", () => {
    expect(
      verifyHostedWebArtifact({
        html: artifact({ mode: "hosted", channel: "dev", serverUrl: "https://runtime.dev.mgpt.mn" }),
        appUrl: "https://app.dev.mgpt.mn",
        runtimeUrl: "https://runtime.dev.mgpt.mn",
        channel: "dev",
      }),
    ).toEqual({
      mode: "hosted",
      channel: "dev",
      serverUrl: "https://runtime.dev.mgpt.mn",
    })
  })

  test("rejects a local bridge artifact before Cloudflare deploy", () => {
    expect(() =>
      verifyHostedWebArtifact({
        html: artifact({ mode: "local-bridge", channel: "dev", serverUrl: "http://localhost:4096" }),
        appUrl: "https://app.dev.mgpt.mn",
        runtimeUrl: "https://runtime.dev.mgpt.mn",
        channel: "dev",
      }),
    ).toThrow("expected hosted")
  })

  test("rejects a channel or runtime deployment mismatch", () => {
    expect(() =>
      verifyHostedWebArtifact({
        html: artifact({ mode: "hosted", channel: "beta", serverUrl: "https://runtime.beta.mgpt.mn" }),
        appUrl: "https://app.dev.mgpt.mn",
        runtimeUrl: "https://runtime.dev.mgpt.mn",
        channel: "dev",
      }),
    ).toThrow("expected dev")
  })
})
