import { describe, expect, test } from "bun:test"

import {
  assertTrustedRendererSource,
  isSafeExternalNavigation,
  isTrustedRendererUrl,
  trustRendererIpc,
} from "./renderer-security"

function rendererEvent(url: string, mainFrame = true) {
  const frame: { url: string; top: unknown } = { url, top: null }
  frame.top = mainFrame ? frame : {}
  return { senderFrame: frame }
}

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

  test("checks renderer trust before invoking privileged IPC handlers", () => {
    let called = false
    const handler = trustRendererIpc((_event, value: string) => {
      called = true
      return value
    })

    expect(handler(rendererEvent("mongolgpt-renderer://renderer/index.html"), "ok")).toBe("ok")
    called = false
    expect(() => handler(rendererEvent("https://attacker.test"), "blocked")).toThrow("Итгэлгүй")
    expect(called).toBe(false)
    expect(() => handler(rendererEvent("mongolgpt-renderer://renderer/index.html", false), "blocked")).toThrow(
      "Итгэлгүй",
    )
  })

  test("registers desktop and WSL IPC only through the trusted wrappers", async () => {
    const ipc = await Bun.file(new URL("./ipc.ts", import.meta.url)).text()
    const wsl = await Bun.file(new URL("./wsl/ipc.ts", import.meta.url)).text()

    expect(ipc.match(/ipcMain\.handle\(/g)).toHaveLength(1)
    expect(ipc.match(/ipcMain\.on\(/g)).toHaveLength(1)
    expect(wsl.match(/ipcMain\.handle\(/g)).toHaveLength(1)
  })

  test("allows only web links to leave the desktop window", () => {
    expect(isSafeExternalNavigation("https://mgpt.mn/docs")).toBe(true)
    expect(isSafeExternalNavigation("http://127.0.0.1:3000/debug")).toBe(true)
    expect(isSafeExternalNavigation("javascript:alert(1)")).toBe(false)
    expect(isSafeExternalNavigation("file:///C:/Users/serge/.ssh/id_rsa")).toBe(false)
    expect(isSafeExternalNavigation("mongolgpt://account/login")).toBe(false)
  })
})
