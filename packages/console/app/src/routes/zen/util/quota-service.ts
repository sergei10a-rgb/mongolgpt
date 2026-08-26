import { Resource } from "@mongolgpt/console-resource"
import type { QuotaLedgerCommand, UsageQueueEvent } from "@mongolgpt/console-core/quota.js"

type JsonObject = Record<string, unknown>

async function callQuotaService(path: string, body: unknown) {
  const response = await Resource.QuotaService.fetch(`https://quota.internal${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${Resource.QuotaServiceToken.value}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })
  const payload = (await response.json().catch(() => ({}))) as JsonObject
  if (!response.ok) {
    const detail = typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`
    throw new Error(`Хязгаарын үйлчилгээний хүсэлт амжилтгүй: ${detail}`)
  }
  return payload
}

export async function ledgerCommand(scope: string, command: QuotaLedgerCommand) {
  return callQuotaService("/v1/ledger", {
    scope: `${Resource.App.stage}:${scope}`,
    command,
  })
}

export async function readLedgerCounters(scope: string, keys: readonly string[]) {
  return numberRecord(await ledgerCommand(scope, { type: "read", keys: [...keys] }))
}

export async function enqueueUsageEvent(event: UsageQueueEvent) {
  await callQuotaService("/v1/usage", event)
}

export function buildRateLimitKey(kind: string, identifier: string, interval?: string) {
  return `${kind}:${identifier}${interval ? `:${interval}` : ""}`
}

export async function hashIdentifier(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export function numberRecord(value: unknown) {
  if (
    !value ||
    typeof value !== "object" ||
    !("values" in value) ||
    !value.values ||
    typeof value.values !== "object"
  ) {
    throw new Error("Хязгаарын үйлчилгээ буруу тоолуурын хариу буцаалаа.")
  }
  return Object.fromEntries(
    Object.entries(value.values).map(([key, item]) => {
      const parsed = Number(item)
      if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("Хязгаарын тоолуурын утга буруу байна.")
      return [key, parsed]
    }),
  )
}

export function claimResult(value: unknown) {
  if (!value || typeof value !== "object" || !("allowed" in value) || typeof value.allowed !== "boolean") {
    throw new Error("Хязгаарын үйлчилгээ нөөцлөх хүсэлтийн буруу хариу буцаалаа.")
  }
  return value as JsonObject & { allowed: boolean }
}
