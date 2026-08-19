import { usePlatform } from "@/context/platform"
import { ServerConnection } from "@/context/server"
import { createServerRequest } from "./server"
import { Accessor, createEffect, onCleanup } from "solid-js"
import { createStore, reconcile } from "solid-js/store"

export type ServerHealthFailureReason =
  | "network"
  | "timeout"
  | "http-error"
  | "html-response"
  | "wrong-content-type"
  | "invalid-response"
  | "unhealthy"

export type ServerHealth =
  | { healthy: true; version?: string }
  | { healthy: false; version?: undefined; reason: ServerHealthFailureReason }

export function serverVersionLabel(version: string | undefined, localLabel: string) {
  if (!version) return
  if (version === "local") return localLabel
  return version.startsWith("v") ? version : `v${version}`
}

interface CheckServerHealthOptions {
  timeoutMs?: number
  signal?: AbortSignal
  retryCount?: number
  retryDelayMs?: number
}

const defaultTimeoutMs = 30_000
const defaultRetryCount = 2
const defaultRetryDelayMs = 100
const cacheMs = 750
const healthCache = new Map<
  string,
  { at: number; done: boolean; fetch: typeof globalThis.fetch; promise: Promise<ServerHealth> }
>()

function cacheKey(server: ServerConnection.HttpBase) {
  return `${server.url}\n${server.username ?? ""}\n${server.password ?? ""}`
}

function timeoutSignal(timeoutMs: number) {
  const timeout = (AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal }).timeout
  if (timeout) {
    try {
      return {
        signal: timeout.call(AbortSignal, timeoutMs),
        clear: undefined as (() => void) | undefined,
      }
    } catch {}
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return { signal: controller.signal, clear: () => clearTimeout(timer) }
}

function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException("Aborted", "AbortError"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function retryable(error: unknown, signal?: AbortSignal) {
  if (signal?.aborted) return false
  if (!(error instanceof Error)) return false
  if (error.name === "AbortError" || error.name === "TimeoutError") return false
  if (error instanceof TypeError) return true
  return /network|fetch|econnreset|econnrefused|enotfound|timedout/i.test(error.message)
}

function unavailable(error: unknown): ServerHealth {
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return { healthy: false, reason: "timeout" }
  }
  return { healthy: false, reason: "network" }
}

function jsonContentType(value: string | null) {
  const mediaType = value?.split(";", 1)[0]?.trim().toLowerCase()
  return mediaType === "application/json" || mediaType?.endsWith("+json") === true
}

function htmlResponse(contentType: string | null, body: string) {
  if (contentType?.toLowerCase().includes("text/html")) return true
  return /^\s*(?:<!doctype\s+html|<html\b)/i.test(body)
}

async function fetchHealth(
  server: ServerConnection.HttpBase,
  fetch: typeof globalThis.fetch,
  signal: AbortSignal | undefined,
): Promise<ServerHealth> {
  const response = await createServerRequest({ server, fetch })("global/health", {
    method: "GET",
    signal,
    headers: { accept: "application/json" },
  })
  const contentType = response.headers.get("content-type")
  const body = await response.text()

  if (htmlResponse(contentType, body)) return { healthy: false, reason: "html-response" }
  if (!jsonContentType(contentType)) return { healthy: false, reason: "wrong-content-type" }
  if (!response.ok) return { healthy: false, reason: "http-error" }

  let data: unknown
  try {
    data = JSON.parse(body)
  } catch {
    return { healthy: false, reason: "invalid-response" }
  }
  if (!data || typeof data !== "object" || !("healthy" in data) || typeof data.healthy !== "boolean") {
    return { healthy: false, reason: "invalid-response" }
  }
  if (!data.healthy) return { healthy: false, reason: "unhealthy" }
  const version = "version" in data && typeof data.version === "string" ? data.version : undefined
  return { healthy: true, version }
}

export async function checkServerHealth(
  server: ServerConnection.HttpBase,
  fetch: typeof globalThis.fetch,
  opts?: CheckServerHealthOptions,
): Promise<ServerHealth> {
  const timeout = opts?.signal ? undefined : timeoutSignal(opts?.timeoutMs ?? defaultTimeoutMs)
  const signal = opts?.signal ?? timeout?.signal
  const retryCount = opts?.retryCount ?? defaultRetryCount
  const retryDelayMs = opts?.retryDelayMs ?? defaultRetryDelayMs
  const next = (count: number, error: unknown) => {
    if (count >= retryCount || !retryable(error, signal)) return Promise.resolve(unavailable(error))
    return wait(retryDelayMs * (count + 1), signal)
      .then(() => attempt(count + 1))
      .catch((waitError) => unavailable(waitError))
  }
  const attempt = (count: number): Promise<ServerHealth> =>
    fetchHealth(server, fetch, signal).catch((error) => next(count, error))
  return attempt(0).finally(() => timeout?.clear?.())
}

const pollMs = 10_000

export function useCheckServerHealth() {
  const platform = usePlatform()
  const fetcher = platform.fetch ?? globalThis.fetch

  return (http: ServerConnection.HttpBase) => {
    const key = cacheKey(http)
    const hit = healthCache.get(key)
    const now = Date.now()
    if (hit && hit.fetch === fetcher && (!hit.done || now - hit.at < cacheMs)) return hit.promise
    const promise = checkServerHealth(http, fetcher).finally(() => {
      const next = healthCache.get(key)
      if (!next || next.promise !== promise) return
      next.done = true
      next.at = Date.now()
    })
    healthCache.set(key, { at: now, done: false, fetch: fetcher, promise })
    return promise
  }
}

export const useServerHealth = (servers: Accessor<ServerConnection.Any[]>, enabled: Accessor<boolean>) => {
  const checkServerHealth = useCheckServerHealth()
  const [status, setStatus] = createStore({} as Record<ServerConnection.Key, ServerHealth | undefined>)

  createEffect(() => {
    if (!enabled()) {
      setStatus(reconcile({}))
      return
    }
    const list = servers()
    let dead = false

    const refresh = async () => {
      const results: Record<string, ServerHealth> = {}
      await Promise.all(
        list.map(async (conn) => {
          const key = ServerConnection.key(conn)
          const result = await checkServerHealth(conn.http)
          results[key] = result
          if (!dead) setStatus(key, result)
        }),
      )
      if (dead) return
      setStatus(reconcile(results))
    }

    void refresh()
    const id = setInterval(() => void refresh(), pollMs)
    onCleanup(() => {
      dead = true
      clearInterval(id)
    })
  })

  return status
}
