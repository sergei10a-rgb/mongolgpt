import { describe, expect, test } from "bun:test"
import { resolveChannel, resolveRuntimeMetadata } from "./build-config.js"

describe("resolveChannel", () => {
  test("accepts the SST Vite environment key", () => {
    expect(resolveChannel({ VITE_MONGOLGPT_CHANNEL: "beta" })).toBe("beta")
  })

  test("prefers the canonical build environment key", () => {
    expect(
      resolveChannel({
        MONGOLGPT_CHANNEL: "prod",
        VITE_MONGOLGPT_CHANNEL: "beta",
      }),
    ).toBe("prod")
  })

  test("maps latest to production", () => {
    expect(resolveChannel({ MONGOLGPT_CHANNEL: "latest" })).toBe("prod")
  })
})

describe("resolveRuntimeMetadata", () => {
  test("describes the default deployed local bridge", () => {
    expect(resolveRuntimeMetadata({})).toEqual({
      mode: "local-bridge",
      serverUrl: "http://localhost:4096",
    })
  })

  test("describes a configured hosted runtime", () => {
    expect(resolveRuntimeMetadata({ VITE_MONGOLGPT_SERVER_URL: "https://runtime.dev.mgpt.mn/" })).toEqual({
      mode: "hosted",
      serverUrl: "https://runtime.dev.mgpt.mn",
    })
  })

  test("builds the local bridge URL from the configured host and port", () => {
    expect(
      resolveRuntimeMetadata({
        VITE_MONGOLGPT_SERVER_HOST: "127.0.0.1",
        VITE_MONGOLGPT_SERVER_PORT: "5096",
      }),
    ).toEqual({
      mode: "local-bridge",
      serverUrl: "http://127.0.0.1:5096",
    })
  })
})
