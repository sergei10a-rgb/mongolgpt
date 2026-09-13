import { expect, test } from "bun:test"
import { resolveRuntimeMetadata } from "./build-config.js"
import { resolveWebRuntime } from "./web-runtime"
import { hostedLoginUrl } from "../components/hosted-account-gate"

const origin = "https://preview.dev.mgpt.mn"
const configuration = {
  MONGOLGPT_CHANNEL: "dev",
  VITE_MONGOLGPT_PREVIEW_ENABLED: "true",
  VITE_MONGOLGPT_APP_URL: origin,
  VITE_MONGOLGPT_SERVER_URL: origin,
  VITE_MONGOLGPT_PUBLIC_URL: "https://dev.mgpt.mn",
}

test("only explicitly enabled exact dev preview can use its private runtime proxy", () => {
  expect(resolveRuntimeMetadata(configuration)).toEqual({ mode: "hosted", serverUrl: origin })
  expect(resolveWebRuntime({ dev: false, origin, serverUrl: origin, ownerPreview: true })).toEqual({
    mode: "hosted",
    serverUrl: origin,
  })
  expect(() => resolveWebRuntime({ dev: false, origin, serverUrl: origin })).toThrow()
  for (const other of ["https://app.dev.mgpt.mn", "https://app.mgpt.mn", "https://preview.dev.mgpt.mn.evil.example"]) {
    expect(() => resolveWebRuntime({ dev: false, origin: other, serverUrl: other, ownerPreview: true })).toThrow()
    expect(() =>
      resolveRuntimeMetadata({ ...configuration, VITE_MONGOLGPT_APP_URL: other, VITE_MONGOLGPT_SERVER_URL: other }),
    ).toThrow()
  }
  expect(() => resolveRuntimeMetadata({ ...configuration, MONGOLGPT_CHANNEL: "prod" })).toThrow()
  expect(() => resolveRuntimeMetadata({ ...configuration, VITE_MONGOLGPT_PREVIEW_ENABLED: "false" })).toThrow()
})

test("preview login has a fixed return target without changing ordinary login", () => {
  expect(new URL(hostedLoginUrl("https://dev.mgpt.mn", origin)).searchParams.get("continue")).toBe("/auth/preview")
  expect(
    new URL(hostedLoginUrl("https://dev.mgpt.mn", "https://runtime.dev.mgpt.mn")).searchParams.get("continue"),
  ).toBe("/auth/app")
  expect(new URL(hostedLoginUrl("https://mgpt.mn", origin)).searchParams.get("continue")).toBe("/auth/app")
})
