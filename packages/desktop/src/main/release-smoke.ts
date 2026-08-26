import type { EventEmitter } from "node:events"
import { writeFileSync } from "node:fs"

type RendererContents = Pick<EventEmitter, "off" | "once"> & {
  getURL(): string
}

export function desktopSmokeFile(env: NodeJS.ProcessEnv = process.env) {
  const value = env.MONGOLGPT_DESKTOP_SMOKE_FILE?.trim()
  return value || undefined
}

export function waitForRendererReady(webContents: RendererContents, timeoutMs = 30_000) {
  return new Promise<string>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout)
      webContents.off("did-finish-load", onReady)
      webContents.off("did-fail-load", onFailure)
    }
    const settle = (result: { url: string } | { error: Error }) => {
      cleanup()
      if ("error" in result) reject(result.error)
      else resolve(result.url)
    }
    const onReady = () => settle({ url: webContents.getURL() })
    const onFailure = (
      _event: unknown,
      errorCode: number,
      errorDescription: string,
      validatedURL: string,
      isMainFrame: boolean,
    ) => {
      if (!isMainFrame) return
      settle({
        error: new Error(`Renderer ачаалагдсангүй (${errorCode}): ${errorDescription} [${validatedURL}]`),
      })
    }
    const timeout = setTimeout(
      () => settle({ error: new Error(`Renderer ${timeoutMs} мс-ийн дотор ачаалагдсангүй.`) }),
      timeoutMs,
    )

    webContents.once("did-finish-load", onReady)
    webContents.once("did-fail-load", onFailure)
  })
}

export function writeDesktopSmokeResult(file: string, input: { version: string; url: string }) {
  writeFileSync(file, `${JSON.stringify({ status: "ready", ...input })}\n`, "utf8")
}
