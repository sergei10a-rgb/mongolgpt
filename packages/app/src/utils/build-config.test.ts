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
  test("keeps the local Web development bridge when no hosted metadata is present", () => {
    expect(resolveRuntimeMetadata({})).toEqual({
      mode: "local-bridge",
      serverUrl: "http://localhost:4096",
    })
  })

  test("describes a configured hosted runtime", () => {
    expect(
      resolveRuntimeMetadata({
        MONGOLGPT_CHANNEL: "dev",
        VITE_MONGOLGPT_APP_URL: "https://app.dev.mgpt.mn",
        VITE_MONGOLGPT_PUBLIC_URL: "https://dev.mgpt.mn",
        VITE_MONGOLGPT_SERVER_URL: "https://runtime.dev.mgpt.mn/",
      }),
    ).toEqual({
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

  test("keeps the desktop local bridge even when a desktop channel is set", () => {
    expect(resolveRuntimeMetadata({ MONGOLGPT_CHANNEL: "prod" })).toEqual({
      mode: "local-bridge",
      serverUrl: "http://localhost:4096",
    })
  })

  test("fails a hosted Web build without a runtime URL", () => {
    expect(() =>
      resolveRuntimeMetadata({
        MONGOLGPT_CHANNEL: "dev",
        VITE_MONGOLGPT_APP_URL: "https://app.dev.mgpt.mn",
        VITE_MONGOLGPT_PUBLIC_URL: "https://dev.mgpt.mn",
      }),
    ).toThrow("локал бус HTTPS ажиллах орчны URL шаардлагатай")
  })

  test("fails a hosted Web build pointed at loopback", () => {
    expect(() =>
      resolveRuntimeMetadata({
        MONGOLGPT_CHANNEL: "beta",
        VITE_MONGOLGPT_APP_URL: "https://app.beta.mgpt.mn",
        VITE_MONGOLGPT_PUBLIC_URL: "https://beta.mgpt.mn",
        VITE_MONGOLGPT_SERVER_URL: "http://[::1]:4096",
      }),
    ).toThrow("локал бус HTTPS ажиллах орчны URL шаардлагатай")
  })

  test("fails a hosted Web build pointed at an alternate loopback address", () => {
    expect(() =>
      resolveRuntimeMetadata({
        MONGOLGPT_CHANNEL: "dev",
        VITE_MONGOLGPT_APP_URL: "https://app.dev.mgpt.mn",
        VITE_MONGOLGPT_PUBLIC_URL: "https://dev.mgpt.mn",
        VITE_MONGOLGPT_SERVER_URL: "https://127.12.34.56:4096",
      }),
    ).toThrow("локал бус HTTPS ажиллах орчны URL шаардлагатай")
  })

  test("fails a hosted Web build pointed at a non-TLS remote runtime", () => {
    expect(() =>
      resolveRuntimeMetadata({
        MONGOLGPT_CHANNEL: "dev",
        VITE_MONGOLGPT_APP_URL: "https://app.dev.mgpt.mn",
        VITE_MONGOLGPT_PUBLIC_URL: "https://dev.mgpt.mn",
        VITE_MONGOLGPT_SERVER_URL: "http://runtime.dev.mgpt.mn",
      }),
    ).toThrow("локал бус HTTPS ажиллах орчны URL шаардлагатай")
  })

  test("fails a hosted Web build pointed at its static app origin", () => {
    expect(() =>
      resolveRuntimeMetadata({
        MONGOLGPT_CHANNEL: "prod",
        VITE_MONGOLGPT_APP_URL: "https://app.mgpt.mn",
        VITE_MONGOLGPT_PUBLIC_URL: "https://mgpt.mn",
        VITE_MONGOLGPT_SERVER_URL: "https://app.mgpt.mn/",
      }),
    ).toThrow("локал бус HTTPS ажиллах орчны URL шаардлагатай")
  })

  test("fails a hosted Web build pointed at a runtime path", () => {
    for (const serverUrl of [
      "https://runtime.dev.mgpt.mn/api",
      "https://runtime.dev.mgpt.mn/runtime/edge",
      "https://runtime.dev.mgpt.mn?tenant=x",
      "https://runtime.dev.mgpt.mn#fragment",
    ]) {
      expect(() =>
        resolveRuntimeMetadata({
          MONGOLGPT_CHANNEL: "dev",
          VITE_MONGOLGPT_APP_URL: "https://app.dev.mgpt.mn",
          VITE_MONGOLGPT_PUBLIC_URL: "https://dev.mgpt.mn",
          VITE_MONGOLGPT_SERVER_URL: serverUrl,
        }),
      ).toThrow("локал бус HTTPS ажиллах орчны URL шаардлагатай")
    }
  })

  test("fails a hosted Web build pointed at a path on its static app origin", () => {
    expect(() =>
      resolveRuntimeMetadata({
        MONGOLGPT_CHANNEL: "dev",
        VITE_MONGOLGPT_APP_URL: "https://app.dev.mgpt.mn",
        VITE_MONGOLGPT_PUBLIC_URL: "https://dev.mgpt.mn",
        VITE_MONGOLGPT_SERVER_URL: "https://app.dev.mgpt.mn/api",
      }),
    ).toThrow("локал бус HTTPS ажиллах орчны URL шаардлагатай")
  })

  test("fails a hosted Web build with a local app URL", () => {
    expect(() =>
      resolveRuntimeMetadata({
        MONGOLGPT_CHANNEL: "dev",
        VITE_MONGOLGPT_APP_URL: "http://localhost:4444",
        VITE_MONGOLGPT_PUBLIC_URL: "https://dev.mgpt.mn",
        VITE_MONGOLGPT_SERVER_URL: "https://runtime.dev.mgpt.mn",
      }),
    ).toThrow("локал бус HTTPS аппын URL шаардлагатай")
  })

  test("fails a legacy hosted Web build without an explicit app URL", () => {
    expect(() =>
      resolveRuntimeMetadata({
        MONGOLGPT_CHANNEL: "dev",
        VITE_MONGOLGPT_PUBLIC_URL: "https://dev.mgpt.mn",
        VITE_MONGOLGPT_SERVER_URL: "https://runtime.dev.mgpt.mn",
      }),
    ).toThrow("локал бус HTTPS аппын URL шаардлагатай")
  })

  test("fails a hosted Web build without a secure public account URL", () => {
    expect(() =>
      resolveRuntimeMetadata({
        MONGOLGPT_CHANNEL: "dev",
        VITE_MONGOLGPT_APP_URL: "https://app.dev.mgpt.mn",
        VITE_MONGOLGPT_PUBLIC_URL: "http://dev.mgpt.mn",
        VITE_MONGOLGPT_SERVER_URL: "https://runtime.dev.mgpt.mn",
      }),
    ).toThrow("локал бус, нийтэд нээлттэй HTTPS URL шаардлагатай")
  })
})
