import type { Hooks, PluginInput } from "@mongolgpt/plugin"
import { createServer, type Server } from "http"
import { createClient } from "@openauthjs/openauth/client"
import { InstallationVersion } from "@mongolgpt/core/installation/version"
import { OauthCallbackPage } from "@mongolgpt/core/oauth/page"
import { productServiceUrls } from "@mongolgpt/core/product"
import { OAUTH_DUMMY_KEY } from "../auth"

const CLIENT_ID = "mongolgpt-cli"
const CONSOLE_URL = process.env.MONGOLGPT_CONSOLE_URL?.trim() || productServiceUrls.console
const AUTH_ISSUER = process.env.MONGOLGPT_AUTH_URL?.trim() || productServiceUrls.auth
const CALLBACK_HOST = "127.0.0.1"
const CALLBACK_PATH = "/auth/callback"
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000
const ACCESS_TOKEN_REFRESH_SKEW_MS = 120_000

type BrowserCallbackServer = {
  redirectUri: string
  code: Promise<string>
  setState: (state: string) => void
  close: () => Promise<void>
}

type UserResponse = {
  id?: unknown
}

function tokenExpiresSoon(expires: number | undefined) {
  return !expires || expires - Date.now() <= ACCESS_TOKEN_REFRESH_SKEW_MS
}

function copyHeaders(requestInput: RequestInfo | URL, init?: RequestInit) {
  const headers = new Headers(requestInput instanceof Request ? requestInput.headers : undefined)
  if (!init?.headers) return headers

  const entries =
    init.headers instanceof Headers
      ? init.headers.entries()
      : Array.isArray(init.headers)
        ? init.headers
        : Object.entries(init.headers as Record<string, string | undefined>)

  for (const [key, value] of entries) {
    if (value !== undefined) headers.set(key, String(value))
  }
  return headers
}

async function closeServer(server: Server) {
  if (!server.listening) return
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

async function startBrowserCallbackServer(): Promise<BrowserCallbackServer> {
  let expectedState = ""
  let timeout: ReturnType<typeof setTimeout> | undefined
  let server!: Server

  const code = new Promise<string>((resolve, reject) => {
    server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", `http://${CALLBACK_HOST}`)
      if (url.pathname !== CALLBACK_PATH) {
        response.writeHead(404).end("Not found")
        return
      }

      const error = url.searchParams.get("error_description") ?? url.searchParams.get("error")
      const value = url.searchParams.get("code")
      const state = url.searchParams.get("state")

      if (error) {
        reject(new Error(error))
        response
          .writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
          .end(OauthCallbackPage.error(error, { provider: "MongolGPT" }))
        return
      }

      if (!value || state !== expectedState) {
        const message = value ? "OAuth state буруу байна" : "Authorization code алга"
        reject(new Error(message))
        response
          .writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
          .end(OauthCallbackPage.error(message, { provider: "MongolGPT" }))
        return
      }

      resolve(value)
      response
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end(OauthCallbackPage.success({ provider: "MongolGPT" }))
    })

    server.once("error", reject)
    timeout = setTimeout(() => reject(new Error("OAuth callback хүлээх хугацаа дууслаа")), CALLBACK_TIMEOUT_MS)
  }).finally(() => {
    if (timeout) clearTimeout(timeout)
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, CALLBACK_HOST, () => resolve())
  })

  const address = server.address()
  if (!address || typeof address === "string") {
    await closeServer(server)
    throw new Error("OAuth callback server port тодорхойгүй байна")
  }

  return {
    redirectUri: `http://${CALLBACK_HOST}:${address.port}${CALLBACK_PATH}`,
    code,
    setState: (state) => {
      expectedState = state
    },
    close: () => closeServer(server),
  }
}

async function fetchAccountID(access: string) {
  const response = await fetch(`${CONSOLE_URL}/api/user`, {
    headers: {
      Authorization: `Bearer ${access}`,
      "User-Agent": `mongolgpt/${InstallationVersion}`,
    },
  }).catch(() => undefined)
  if (!response?.ok) return undefined

  const user = (await response.json().catch(() => undefined)) as UserResponse | undefined
  return typeof user?.id === "string" ? user.id : undefined
}

export async function MongolGPTAuthPlugin(input: PluginInput): Promise<Hooks> {
  const client = createClient({ clientID: CLIENT_ID, issuer: AUTH_ISSUER })
  let refreshPromise:
    | Promise<{
        access: string
        refresh: string
        expires: number
        accountId?: string
      }>
    | undefined

  return {
    auth: {
      provider: "mongolgpt",
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth.type !== "oauth") return {}

        return {
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            let currentAuth = await getAuth()
            if (currentAuth.type !== "oauth") return fetch(requestInput, init)

            if (tokenExpiresSoon(currentAuth.expires)) {
              if (!refreshPromise) {
                const refreshToken = currentAuth.refresh
                const currentAccountId = currentAuth.accountId
                refreshPromise = client
                  .refresh(refreshToken)
                  .then(async (result) => {
                    if (result.err || !result.tokens) throw result.err
                    const accountId = (await fetchAccountID(result.tokens.access)) ?? currentAccountId
                    const next = {
                      access: result.tokens.access,
                      refresh: result.tokens.refresh,
                      expires: Date.now() + result.tokens.expiresIn * 1000,
                      ...(accountId ? { accountId } : {}),
                    }
                    await input.client.auth
                      .set({
                        path: { id: "mongolgpt" },
                        body: {
                          type: "oauth",
                          ...next,
                          enterpriseUrl: AUTH_ISSUER,
                        },
                      })
                      .catch(() => {})
                    return next
                  })
                  .finally(() => {
                    refreshPromise = undefined
                  })
              }
              currentAuth = { ...currentAuth, ...(await refreshPromise) }
            }

            const headers = copyHeaders(requestInput, init)
            headers.set("authorization", `Bearer ${currentAuth.access}`)
            headers.set("User-Agent", `mongolgpt/${InstallationVersion}`)
            return fetch(requestInput, { ...init, headers })
          },
        }
      },
      methods: [
        {
          label: "MongolGPT аккаунтаар нэвтрэх",
          type: "oauth",
          authorize: async () => {
            const callback = await startBrowserCallbackServer()
            const authorization = await client.authorize(callback.redirectUri, "code", { pkce: true })
            callback.setState(authorization.challenge.state)

            return {
              url: authorization.url,
              instructions: "Browser дээрээ MongolGPT нэвтрэлтийг баталгаажуулна уу. Энэ цонх автоматаар хаагдана.",
              method: "auto" as const,
              callback: async () => {
                try {
                  const code = await callback.code
                  const exchanged = await client.exchange(code, callback.redirectUri, authorization.challenge.verifier)
                  if (exchanged.err) throw exchanged.err

                  const accountId = await fetchAccountID(exchanged.tokens.access)
                  return {
                    type: "success" as const,
                    refresh: exchanged.tokens.refresh,
                    access: exchanged.tokens.access,
                    expires: Date.now() + exchanged.tokens.expiresIn * 1000,
                    enterpriseUrl: AUTH_ISSUER,
                    ...(accountId ? { accountId } : {}),
                  }
                } finally {
                  await callback.close()
                }
              },
            }
          },
        },
        {
          label: "API key (service account)",
          type: "api",
        },
      ],
    },
  }
}
