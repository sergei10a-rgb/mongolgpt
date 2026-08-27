import { expect, type BrowserContext, type Page, type Request } from "@playwright/test"
import { isStaticAppBackendPath } from "../../src/utils/static-app-router"

const blockedDocumentTypes = new Set(["document", "script", "stylesheet", "font"])
const backendResourceTypes = new Set(["fetch", "xhr"])
const observedResourceTypes = new Set([...blockedDocumentTypes, ...backendResourceTypes])
const smokeAuthCookieName = "__Host-mongolgpt-auth"

type ObservedApiResponse = {
  origin: string
  method: string
  pathname: string
  status: number
  contentType: string
  cacheControl: string
}

export function observeDeployedPage(page: Page, appOrigin: string, apiOrigins: string[] = []) {
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  const failedRequests: string[] = []
  const suspiciousRequests: string[] = []
  const htmlResponses: string[] = []
  const observedApiResponses: ObservedApiResponse[] = []
  const pendingRequests = new Set<Request>()
  const allowedApiOrigins = new Set(apiOrigins)

  page.on("pageerror", (error) => {
    pageErrors.push(error.stack ?? error.message)
  })

  page.on("console", (message) => {
    if (message.type() !== "error") return
    const text = message.text()
    if (isBenignConsoleError(text)) return
    consoleErrors.push(text)
  })

  page.on("request", (request) => {
    if (observedResourceTypes.has(request.resourceType())) pendingRequests.add(request)

    const url = new URL(request.url())
    if (url.origin !== appOrigin) return
    if (!backendResourceTypes.has(request.resourceType()) && !isStaticAppBackendPath(url.pathname)) return
    suspiciousRequests.push(`${request.resourceType()} ${request.method()} ${request.url()}`)
  })

  page.on("requestfinished", (request) => {
    pendingRequests.delete(request)
  })

  page.on("requestfailed", (request) => {
    pendingRequests.delete(request)
    if (!observedResourceTypes.has(request.resourceType())) return
    failedRequests.push(
      `${request.resourceType()}:${request.method()} ${request.url()} :: ${request.failure()?.errorText ?? "failed"}`,
    )
  })

  page.on("response", (response) => {
    const request = response.request()
    const url = new URL(request.url())
    const pathname = url.pathname
    const origin = url.origin
    const contentType = (response.headers()["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase()
    const cacheControl = (response.headers()["cache-control"] ?? "").trim().toLowerCase()

    if (origin === appOrigin) {
      if (request.resourceType() === "document" && response.status() >= 400) {
        failedRequests.push(`document:${response.status()} ${request.url()}`)
      }

      if (
        request.resourceType() !== "document" &&
        response.status() >= 400 &&
        blockedDocumentTypes.has(request.resourceType())
      ) {
        failedRequests.push(`${request.resourceType()}:${response.status()} ${request.url()}`)
      }

      if (isStaticAppBackendPath(pathname) && contentType.includes("text/html")) {
        htmlResponses.push(`${response.status()} ${request.url()}`)
      }
      return
    }

    if (
      allowedApiOrigins.has(origin) &&
      isStaticAppBackendPath(pathname) &&
      backendResourceTypes.has(request.resourceType())
    ) {
      observedApiResponses.push({
        origin,
        method: request.method(),
        pathname,
        status: response.status(),
        contentType,
        cacheControl,
      })
    }
  })

  return {
    pageErrors,
    consoleErrors,
    failedRequests,
    suspiciousRequests,
    htmlResponses,
    observedApiResponses,
    pendingRequests,
  }
}

export function expectNoDeployedSmokeFailures(state: ReturnType<typeof observeDeployedPage>) {
  expect(state.pageErrors, "page errors").toEqual([])
  expect(state.consoleErrors, "console errors").toEqual([])
  expect(state.failedRequests, "failed requests").toEqual([])
  expect(state.suspiciousRequests, "same-origin api-like requests").toEqual([])
  expect(state.htmlResponses, "html returned from api-like requests").toEqual([])
}

function isBenignConsoleError(text: string) {
  return ["Download the React DevTools", "favicon", "Manifest: Line"].some((fragment) => text.includes(fragment))
}

export function isVisibleMongolianText(text: string) {
  return /[\u0410-\u042f\u0430-\u044f\u04e8\u04e9\u04ae\u04af]/u.test(text) && text.trim().length > 20
}

export async function installSmokeAuthCookie(context: BrowserContext, publicOrigin: string) {
  const rawCookie = process.env.MONGOLGPT_SMOKE_AUTH_COOKIE
  if (!rawCookie) {
    if (process.env.CI)
      throw new Error("MONGOLGPT_SMOKE_AUTH_COOKIE is required in CI for the authenticated deployed smoke test")
    return false
  }

  const cookie = parseSmokeAuthCookie(rawCookie, publicOrigin)
  try {
    await context.addCookies([cookie])
  } catch {
    throw new Error("MONGOLGPT_SMOKE_AUTH_COOKIE could not be installed in the deployed browser session")
  }
  return true
}

export function parseSmokeAuthCookie(rawCookie: string, publicOrigin: string) {
  const publicUrl = new URL(publicOrigin)
  if (publicUrl.protocol !== "https:") throw new Error("PLAYWRIGHT_DEPLOYED_PUBLIC_URL must use HTTPS")
  if (rawCookie.length > 4_096 || rawCookie.trim() !== rawCookie) {
    throw new Error("MONGOLGPT_SMOKE_AUTH_COOKIE is malformed")
  }

  const prefix = `${smokeAuthCookieName}=`
  if (!rawCookie.startsWith(prefix)) {
    throw new Error(`MONGOLGPT_SMOKE_AUTH_COOKIE must contain only the ${smokeAuthCookieName} cookie`)
  }
  const value = rawCookie.slice(prefix.length)
  if (value.length < 16 || !/^[\x21-\x7e]+$/.test(value) || /[;,"\\]/.test(value)) {
    throw new Error("MONGOLGPT_SMOKE_AUTH_COOKIE is malformed")
  }

  return {
    name: smokeAuthCookieName,
    value,
    url: publicUrl.origin,
    httpOnly: true,
    secure: true,
    sameSite: "Lax" as const,
  }
}
