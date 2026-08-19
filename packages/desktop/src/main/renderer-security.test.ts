import { describe, expect, test } from "bun:test"

import {
  assertTrustedRendererSource,
  isSafeExternalNavigation,
  isTrustedRendererUrl,
} from "./renderer-security"

describe("desktop renderer security", () => {
  test("trusts only the packaged renderer origin", () => {
    expect(isTrustedRendererUrl("mongolgpt-renderer://renderer/index.html", "")).toBe(true)
    expect(isTrustedRendererUrl("mongolgpt-renderer://renderer/settings", "")).toBe(true)
    expect(isTrustedRendererUrl("mongolgpt-renderer://attacker/index.html", "")).toBe(false)
    expect(isTrustedRendererUrl("https://renderer/index.html", "")).toBe(false)
  })

  test("trusts the exact development renderer origin", () => {
    const dev = "http://127.0.0.1:5173"
    expect(isTrustedRendererUrl("http://127.0.0.1:5173/session", dev)).toBe(true)
    expect(isTrustedRendererUrl("http://127.0.0.1:5174/session", dev)).toBe(false)
    expect(isTrustedRendererUrl("http://127.0.0.1:5173.attacker.test/session", dev)).toBe(false)
  })

  test("requires account IPC calls to come from the main renderer frame", () => {
    expect(() => assertTrustedRendererSource("mongolgpt-renderer://renderer/index.html", true)).not.toThrow()
    expect(() => assertTrustedRendererSource("mongolgpt-renderer://renderer/index.html", false)).toThrow("Итгэлгүй")
    expect(() => assertTrustedRendererSource("https://attacker.test", true)).toThrow("Итгэлгүй")
  })

  test("allows only web links to leave the desktop window", () => {
    expect(isSafeExternalNavigation("https://mgpt.mn/docs")).toBe(true)
    expect(isSafeExternalNavigation("http://127.0.0.1:3000/debug")).toBe(true)
    expect(isSafeExternalNavigation("javascript:alert(1)")).toBe(false)
    expect(isSafeExternalNavigation("file:///C:/Users/serge/.ssh/id_rsa")).toBe(false)
    expect(isSafeExternalNavigation("mongolgpt://account/login")).toBe(false)
  })
})
