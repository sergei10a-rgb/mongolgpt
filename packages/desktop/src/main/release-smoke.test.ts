import { afterEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  desktopSmokeFile,
  rendererSmokeFailure,
  waitForRendererAccountGate,
  waitForRendererReady,
  writeDesktopSmokeResult,
} from "./release-smoke"

const files: string[] = []

afterEach(() => {
  for (const file of files.splice(0)) rmSync(file, { force: true })
})

function renderer(url = "mongolgpt-renderer://renderer/index.html", states: unknown[] = []) {
  let index = 0
  return Object.assign(new EventEmitter(), {
    getURL: () => url,
    executeJavaScript: async () => states[Math.min(index++, Math.max(states.length - 1, 0))],
  })
}

const accountGate = {
  language: "mn",
  onboardingStage: "account",
  accountGateVisible: true,
  accountHeading: "MongolGPT бүртгэлээрээ нэвтэрнэ үү",
  loginAction: "Бүртгүүлэх эсвэл нэвтрэх",
}

describe("desktop release smoke", () => {
  test("enables smoke mode only for a non-empty marker path", () => {
    expect(desktopSmokeFile({ MONGOLGPT_DESKTOP_SMOKE_FILE: " C:\\smoke.json " })).toBe("C:\\smoke.json")
    expect(desktopSmokeFile({ MONGOLGPT_DESKTOP_SMOKE_FILE: "  " })).toBeUndefined()
    expect(desktopSmokeFile({})).toBeUndefined()
  })

  test("waits for the packaged renderer main frame", async () => {
    const webContents = renderer()
    const ready = waitForRendererReady(webContents, 100)

    webContents.emit("did-fail-load", {}, -3, "subframe", "https://example.com", false)
    webContents.emit("did-finish-load")

    expect(await ready).toBe("mongolgpt-renderer://renderer/index.html")
    expect(webContents.listenerCount("did-finish-load")).toBe(0)
    expect(webContents.listenerCount("did-fail-load")).toBe(0)
  })

  test("rejects a failed renderer main frame", async () => {
    const webContents = renderer()
    const ready = waitForRendererReady(webContents, 100)

    webContents.emit("did-fail-load", {}, -6, "ERR_FILE_NOT_FOUND", "mongolgpt-renderer://renderer/index.html", true)

    await expect(ready).rejects.toThrow("ERR_FILE_NOT_FOUND")
  })

  test("times out without leaking renderer listeners", async () => {
    const webContents = renderer()
    const ready = waitForRendererReady(webContents, 1)

    await expect(ready).rejects.toThrow("1 мс")
    expect(webContents.listenerCount("did-finish-load")).toBe(0)
    expect(webContents.listenerCount("did-fail-load")).toBe(0)
  })

  test("waits for the visible Mongolian account onboarding gate", async () => {
    const webContents = renderer(undefined, [{ ...accountGate, accountGateVisible: false }, accountGate])

    await expect(waitForRendererAccountGate(webContents, 100, 1)).resolves.toEqual(accountGate)
  })

  test("rejects malformed or non-account onboarding state", async () => {
    const webContents = renderer(undefined, [
      { ...accountGate, language: "en" },
      { ...accountGate, onboardingStage: "providers" },
      { ...accountGate, loginAction: 42 },
    ])

    await expect(waitForRendererAccountGate(webContents, 5, 1)).rejects.toThrow("аккаунтын Монгол onboarding")
  })

  test("writes a machine-readable success marker", () => {
    const file = join(tmpdir(), `mongolgpt-desktop-smoke-${randomUUID()}.json`)
    files.push(file)

    writeDesktopSmokeResult(file, {
      version: "1.2.3",
      url: "mongolgpt-renderer://renderer/index.html",
      ...accountGate,
    })

    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      status: "ready",
      version: "1.2.3",
      url: "mongolgpt-renderer://renderer/index.html",
      ...accountGate,
    })
  })

  test("fails smoke when the renderer error boundary reports a fatal error", () => {
    expect(rendererSmokeFailure(undefined)).toBeUndefined()
    expect(rendererSmokeFailure({ error: "  startup failed  " })?.message).toContain("startup failed")
  })
})
