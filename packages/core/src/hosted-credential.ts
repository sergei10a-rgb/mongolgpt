export * as HostedCredential from "./hosted-credential"

import { runtimeGatewayHeader } from "@mongolgpt/runtime-auth"

export const Header = runtimeGatewayHeader
export const EnvironmentName = "MONGOLGPT_API_KEY"
export const Placeholder = "runtime"

const RuntimeMode = "hosted"
const MaximumTokenLength = 8 * 1024
const MaximumLifetimeMilliseconds = 125_000

let current: { token: string; expiresAt: number } | undefined

export function capture(value: string | undefined, now = Date.now()) {
  if (!enabled() || !value || value.length > MaximumTokenLength) return false
  const expiresAt = expiration(value)
  if (!expiresAt || expiresAt <= now || expiresAt > now + MaximumLifetimeMilliseconds) return false
  current = { token: value, expiresAt }
  return true
}

export function resolve(name: string, value: string | undefined, now = Date.now()) {
  if (name !== EnvironmentName || value !== Placeholder || !enabled()) return value
  if (!current || current.expiresAt <= now) {
    current = undefined
    return undefined
  }
  return current.token
}

export function clear() {
  current = undefined
}

function enabled() {
  return process.env.MONGOLGPT_RUNTIME_MODE === RuntimeMode
}

function expiration(token: string) {
  const parts = token.split(".")
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return undefined
  try {
    const payload = JSON.parse(decodeBase64Url(parts[1])) as unknown
    if (!record(payload)) return undefined
    const expires = payload.exp
    if (typeof expires !== "number" || !Number.isSafeInteger(expires) || expires < 0) return undefined
    return expires * 1000
  } catch {
    return undefined
  }
}

function decodeBase64Url(value: string) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4)
  const binary = atob(base64)
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
