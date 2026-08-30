import type { EventEmitter } from "node:events"
import { writeFileSync } from "node:fs"
import type { ReleaseFunctionalSmokeResult } from "./release-functional-smoke"

type RendererContents = Pick<EventEmitter, "off" | "once"> & {
  getURL(): string
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>
}

export type DesktopAccountGateState = {
  language: string
  onboardingStage: string
  accountGateVisible: boolean
  accountLogo: string
  accountHeading: string
  loginAction: string
}

const expectedAccountGate = {
  language: "mn",
  onboardingStage: "account",
  accountGateVisible: true,
  accountLogo: "mongolgpt",
  accountHeading: "MongolGPT бүртгэлээрээ нэвтэрнэ үү",
  loginAction: "Бүртгүүлэх эсвэл нэвтрэх",
} satisfies DesktopAccountGateState

const accountGateProbe = `(() => {
  const root = document.querySelector('[data-mongolgpt-account-onboarding-stage]')
  const logo = document.querySelector('[data-mongolgpt-account-login-logo]')
  const logoSymbol = logo?.querySelector('use')?.getAttribute('href')?.split('#').at(-1) ?? ''
  const heading = document.querySelector('[data-mongolgpt-account-login-heading]')
  const action = document.querySelector('[data-mongolgpt-account-login-action]')
  return {
    language: document.documentElement.lang,
    onboardingStage: root?.getAttribute('data-mongolgpt-account-onboarding-stage') ?? '',
    accountGateVisible: root instanceof HTMLElement && heading instanceof HTMLElement && action instanceof HTMLElement,
    accountLogo: logo instanceof SVGElement ? logoSymbol : '',
    accountHeading: heading?.textContent?.trim() ?? '',
    loginAction: action?.textContent?.trim() ?? '',
  }
})()`

function accountGateState(value: unknown): DesktopAccountGateState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const language = Reflect.get(value, "language")
  const onboardingStage = Reflect.get(value, "onboardingStage")
  const accountGateVisible = Reflect.get(value, "accountGateVisible")
  const accountLogo = Reflect.get(value, "accountLogo")
  const accountHeading = Reflect.get(value, "accountHeading")
  const loginAction = Reflect.get(value, "loginAction")
  if (
    typeof language !== "string" ||
    typeof onboardingStage !== "string" ||
    typeof accountGateVisible !== "boolean" ||
    typeof accountLogo !== "string" ||
    typeof accountHeading !== "string" ||
    typeof loginAction !== "string"
  )
    return undefined
  return {
    language,
    onboardingStage,
    accountGateVisible,
    accountLogo,
    accountHeading,
    loginAction,
  }
}

function accountGateReady(state: DesktopAccountGateState | undefined): state is DesktopAccountGateState {
  if (!state) return false
  return (
    state.language === expectedAccountGate.language &&
    state.onboardingStage === expectedAccountGate.onboardingStage &&
    state.accountGateVisible === expectedAccountGate.accountGateVisible &&
    state.accountLogo === expectedAccountGate.accountLogo &&
    state.accountHeading === expectedAccountGate.accountHeading &&
    state.loginAction === expectedAccountGate.loginAction
  )
}

export function desktopSmokeFile(env: NodeJS.ProcessEnv = process.env) {
  const value = env.MONGOLGPT_DESKTOP_SMOKE_FILE?.trim()
  return value || undefined
}

function loadedRendererURL(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === "mongolgpt-renderer:" && url.hostname === "renderer"
  } catch {
    return false
  }
}

export function waitForRendererReady(webContents: RendererContents, timeoutMs = 30_000) {
  const currentURL = webContents.getURL()
  if (loadedRendererURL(currentURL)) return Promise.resolve(currentURL)

  return new Promise<string>((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => {
      if (timeout) clearTimeout(timeout)
      webContents.off("did-finish-load", onReady)
      webContents.off("did-fail-load", onFailure)
    }
    const settle = (result: { url: string } | { error: Error }) => {
      cleanup()
      if ("error" in result) reject(result.error)
      else resolve(result.url)
    }
    const onReady = () => {
      const url = webContents.getURL()
      if (loadedRendererURL(url)) settle({ url })
      else settle({ error: new Error(`Renderer буруу төлөвт ачаалагдлаа: ${webContents.getURL() || "хоосон URL"}`) })
    }
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
    timeout = setTimeout(
      () => settle({ error: new Error(`Renderer ${timeoutMs} мс-ийн дотор ачаалагдсангүй.`) }),
      timeoutMs,
    )

    webContents.once("did-finish-load", onReady)
    webContents.once("did-fail-load", onFailure)

    const loadedAfterSubscription = webContents.getURL()
    if (loadedRendererURL(loadedAfterSubscription)) settle({ url: loadedAfterSubscription })
  })
}

export async function waitForRendererAccountGate(webContents: RendererContents, timeoutMs = 30_000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs
  let lastState: DesktopAccountGateState | undefined

  while (Date.now() <= deadline) {
    try {
      lastState = accountGateState(await webContents.executeJavaScript(accountGateProbe))
      if (accountGateReady(lastState)) return lastState
    } catch {
      lastState = undefined
    }
    if (Date.now() >= deadline) break
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  const detail = lastState ? ` Сүүлийн төлөв: ${JSON.stringify(lastState)}` : ""
  throw new Error(`MongolGPT аккаунтын Монгол onboarding ${timeoutMs} мс-ийн дотор харагдсангүй.${detail}`)
}

export function writeDesktopSmokeResult(
  file: string,
  input: { version: string; url: string; functional: ReleaseFunctionalSmokeResult } & DesktopAccountGateState,
) {
  writeFileSync(file, `${JSON.stringify({ status: "ready", ...input })}\n`, "utf8")
}

export function writeDesktopSmokeFailure(file: string, error: string) {
  writeFileSync(file, `${JSON.stringify({ status: "error", error: error.trim().slice(0, 4_096) })}\n`, "utf8")
}

export function rendererSmokeFailure(value: { error: string } | undefined): Error | undefined {
  if (!value) return undefined
  const message = typeof value.error === "string" ? value.error.trim().slice(0, 4_096) : ""
  return new Error(`Renderer эхлэх үед ноцтой алдаа гарлаа${message ? `: ${message}` : ""}`)
}
