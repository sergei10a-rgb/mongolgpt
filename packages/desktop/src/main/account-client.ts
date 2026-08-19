import type { DesktopAccount, DesktopAccountAPI, ServerReadyData } from "../preload/types"
import { AccountOverviewSchema, type AccountOverview } from "@mongolgpt/account-contract"

type Dependencies = {
  server: () => Promise<ServerReadyData>
  accountServer: string
  openExternal: (url: string) => Promise<unknown>
  fetch?: typeof fetch
  sleep?: (milliseconds: number) => Promise<void>
  now?: () => number
  pollIntervalMs?: number
  loginTimeoutMs?: number
  cancelTimeoutMs?: number
}

type LoginStarted = { loginID: string; url: string }
type LoginStatus =
  | { _tag: "pending" }
  | { _tag: "success"; id: string; email: string }
  | { _tag: "error"; message: string }

const jsonContentType = (value: string | null) => value?.toLowerCase().includes("application/json") === true

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function parseAccount(value: unknown): DesktopAccount | null {
  if (value === null) return null
  if (!isRecord(value)) throw new Error("Дагалдах сервер бүртгэлийн буруу хариу буцаалаа")
  if (typeof value.id !== "string" || typeof value.email !== "string" || typeof value.url !== "string") {
    throw new Error("Дагалдах сервер бүртгэлийн дутуу хариу буцаалаа")
  }
  if (value.activeOrgID !== undefined && typeof value.activeOrgID !== "string") {
    throw new Error("Дагалдах сервер байгууллагын буруу мэдээлэл буцаалаа")
  }
  return {
    id: value.id,
    email: value.email,
    url: value.url,
    ...(value.activeOrgID ? { activeOrgID: value.activeOrgID } : {}),
  }
}

function parseAccountOverview(value: unknown): AccountOverview | null {
  if (value === null) return null
  const parsed = AccountOverviewSchema.safeParse(value)
  if (!parsed.success) throw new Error("Дагалдах сервер бүртгэлийн төлөвийн буруу хариу буцаалаа")
  return parsed.data
}

function parseLoginStarted(value: unknown): LoginStarted {
  if (!isRecord(value) || typeof value.loginID !== "string" || typeof value.url !== "string") {
    throw new Error("Нэвтрэх үйлдлийг эхлүүлсэн хариу буруу байна")
  }
  return { loginID: value.loginID, url: value.url }
}

function parseLoginStatus(value: unknown): LoginStatus {
  if (!isRecord(value) || typeof value._tag !== "string") {
    throw new Error("Нэвтрэх төлөвийн хариу буруу байна")
  }
  if (value._tag === "pending") return { _tag: "pending" }
  if (value._tag === "success" && typeof value.id === "string" && typeof value.email === "string") {
    return { _tag: "success", id: value.id, email: value.email }
  }
  if (value._tag === "error" && typeof value.message === "string") {
    return { _tag: "error", message: value.message }
  }
  throw new Error("Нэвтрэх төлөвийн хариу танигдсангүй")
}

function safeAuthorizationUrl(value: string) {
  const url = new URL(value)
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1"
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Нэвтрэх холбоос аюулгүй HTTPS хаяг биш байна")
  }
  return url.toString()
}

export function createDesktopAccountClient(dependencies: Dependencies): DesktopAccountAPI {
  const requestFetch = dependencies.fetch ?? globalThis.fetch
  const wait =
    dependencies.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  const now = dependencies.now ?? Date.now
  const pollInterval = dependencies.pollIntervalMs ?? 500
  const loginTimeout = dependencies.loginTimeoutMs ?? 11 * 60 * 1000
  const cancelTimeout = dependencies.cancelTimeoutMs ?? 2_000

  const request = async (path: string, init?: RequestInit, signal?: AbortSignal) => {
    const server = await dependencies.server()
    if (!server.username || !server.password) throw new Error("Дагалдах серверийн нэвтрэх мэдээлэл олдсонгүй")
    const headers = new Headers(init?.headers)
    headers.set("authorization", `Basic ${Buffer.from(`${server.username}:${server.password}`).toString("base64")}`)
    if (init?.body !== undefined) headers.set("content-type", "application/json")
    headers.set("accept", "application/json")

    const response = await requestFetch(new URL(path, server.url), { ...init, headers, signal })
    if (!response.ok) throw new Error(`Дагалдах серверийн хүсэлт амжилтгүй боллоо (${response.status})`)
    if (!jsonContentType(response.headers.get("content-type"))) {
      throw new Error("Дагалдах сервер JSON-ийн оронд буруу төрлийн хариу буцаалаа")
    }
    return response.json() as Promise<unknown>
  }

  const current = async (signal?: AbortSignal) =>
    parseAccount(await request("/experimental/account", undefined, signal))

  const overview = async (workspaceID?: string) => {
    if (workspaceID !== undefined && typeof workspaceID !== "string") {
      throw new Error("Ажлын орчны ID буруу байна")
    }
    const selected = workspaceID?.trim()
    const query = selected ? `?workspaceID=${encodeURIComponent(selected)}` : ""
    return parseAccountOverview(await request(`/experimental/account/overview${query}`))
  }

  const cancel = async (loginID: string, timeout: number) => {
    if (timeout <= 0) return
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    await request(
      `/experimental/account/login/${encodeURIComponent(loginID)}`,
      { method: "DELETE" },
      controller.signal,
    ).catch(() => {})
    clearTimeout(timer)
  }

  const login = async () => {
    const deadline = now() + loginTimeout
    const loginController = new AbortController()
    const loginTimer = setTimeout(() => loginController.abort(), Math.max(0, loginTimeout))
    let started: LoginStarted | undefined

    try {
      started = parseLoginStarted(
        await request(
          "/experimental/account/login",
          {
            method: "POST",
            body: JSON.stringify({ server: dependencies.accountServer }),
          },
          loginController.signal,
        ),
      )
      await dependencies.openExternal(safeAuthorizationUrl(started.url))
      while (now() < deadline) {
        const status = parseLoginStatus(
          await request(
            `/experimental/account/login/${encodeURIComponent(started.loginID)}`,
            undefined,
            loginController.signal,
          ),
        )
        if (status._tag === "pending") {
          await wait(pollInterval)
          continue
        }
        if (status._tag === "error") throw new Error(status.message)

        const account = await current(loginController.signal)
        if (!account || account.id !== status.id || account.email !== status.email) {
          throw new Error("Нэвтэрсэн бүртгэлийг баталгаажуулж чадсангүй")
        }
        return account
      }
      throw new Error("Нэвтрэх хугацаа дууссан")
    } catch (error) {
      if (loginController.signal.aborted || now() >= deadline) {
        throw new Error("Нэвтрэх хугацаа дууссан")
      }
      throw error
    } finally {
      clearTimeout(loginTimer)
      if (started) await cancel(started.loginID, Math.min(cancelTimeout, Math.max(0, deadline - now())))
    }
  }

  const logout = async () => {
    await request("/experimental/account", { method: "DELETE" })
  }

  return { current, overview, login, logout }
}
