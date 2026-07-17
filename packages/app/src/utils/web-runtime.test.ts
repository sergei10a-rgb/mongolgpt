import { describe, expect, test } from "bun:test"
import { resolveDefaultServerUrl, resolveWebRuntime } from "./web-runtime"

describe("resolveWebRuntime", () => {
  test("uses the local bridge for a deployed static app without a hosted runtime", () => {
    expect(
      resolveWebRuntime({
        dev: false,
        origin: "https://app.dev.mgpt.mn",
      }),
    ).toEqual({
      mode: "local-bridge",
      serverUrl: "http://localhost:4096",
    })
  })

  test("uses the configured development host and port", () => {
    expect(
      resolveWebRuntime({
        dev: true,
        origin: "http://localhost:5173",
        serverHost: "127.0.0.1",
        serverPort: "4100",
      }),
    ).toEqual({
      mode: "local-bridge",
      serverUrl: "http://127.0.0.1:4100",
    })
  })

  test("uses an explicit hosted runtime URL", () => {
    expect(
      resolveWebRuntime({
        dev: false,
        origin: "https://app.dev.mgpt.mn",
        serverUrl: "https://runtime.dev.mgpt.mn/",
      }),
    ).toEqual({
      mode: "hosted",
      serverUrl: "https://runtime.dev.mgpt.mn",
    })
  })

  test("rejects unsupported runtime URL protocols", () => {
    expect(() =>
      resolveWebRuntime({
        dev: false,
        origin: "https://app.dev.mgpt.mn",
        serverUrl: "javascript:alert(1)",
      }),
    ).toThrow("http")
  })
})

describe("resolveDefaultServerUrl", () => {
  const runtime = {
    mode: "local-bridge" as const,
    serverUrl: "http://localhost:4096",
  }

  test("drops the legacy static app origin that was stored as an API server", () => {
    expect(
      resolveDefaultServerUrl({
        runtime,
        storedUrl: "https://app.dev.mgpt.mn",
        appOrigin: "https://app.dev.mgpt.mn",
      }),
    ).toEqual({
      url: "http://localhost:4096",
      clearStored: true,
    })
  })

  test("drops the legacy static app origin when a hosted runtime is configured", () => {
    expect(
      resolveDefaultServerUrl({
        runtime: {
          mode: "hosted",
          serverUrl: "https://runtime.dev.mgpt.mn",
        },
        storedUrl: "https://app.dev.mgpt.mn/",
        appOrigin: "https://app.dev.mgpt.mn",
      }),
    ).toEqual({
      url: "https://runtime.dev.mgpt.mn",
      clearStored: true,
    })
  })

  test("keeps an explicitly selected different server", () => {
    expect(
      resolveDefaultServerUrl({
        runtime,
        storedUrl: "http://127.0.0.1:9000/",
        appOrigin: "https://app.dev.mgpt.mn",
      }),
    ).toEqual({
      url: "http://127.0.0.1:9000",
      clearStored: false,
    })
  })
})
