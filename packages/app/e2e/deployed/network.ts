import { expect, type Page, type Request } from "@playwright/test"

const blockedDocumentTypes = new Set(["document", "script", "stylesheet", "font"])
const apiLikePath = /^\/(api|auth|session|model|v1)(\/|$)/
const backendResourceTypes = new Set(["fetch", "xhr"])
const observedResourceTypes = new Set([...blockedDocumentTypes, ...backendResourceTypes])

export function observeDeployedPage(page: Page, appOrigin: string) {
  const pageErrors: string[] = []
  const consoleErrors: string[] = []
  const failedRequests: string[] = []
  const suspiciousRequests: string[] = []
  const htmlResponses: string[] = []
  const pendingRequests = new Set<Request>()

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
    if (!backendResourceTypes.has(request.resourceType()) && !apiLikePath.test(url.pathname)) return
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
    if (new URL(request.url()).origin !== appOrigin) return

    const pathname = new URL(request.url()).pathname
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

    const contentType = response.headers()["content-type"] ?? ""
    if (apiLikePath.test(pathname) && contentType.toLowerCase().includes("text/html")) {
      htmlResponses.push(`${response.status()} ${request.url()}`)
    }
  })

  return { pageErrors, consoleErrors, failedRequests, suspiciousRequests, htmlResponses, pendingRequests }
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
