import { UsageQueueHeartbeatEvidenceSchema, usageQueueReadinessKey } from "../../console/core/src/usage-queue-readiness"

const account = "cc97ad90bfaf8a1da5de612eef2658f5"
const namespace = "edb0d61cd18a4dda889cf550ac00ab3f"
const url = `https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces/${namespace}/values/${encodeURIComponent(usageQueueReadinessKey("dev"))}`

export async function verifyDevUsageQueueHeartbeat(
  input: { accountId: string; token: string; notBefore: number },
  dependencies: { fetch?: typeof fetch; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
) {
  const now = dependencies.now ?? Date.now
  const request = dependencies.fetch ?? fetch
  const sleep = dependencies.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const started = now()
  if (
    input.accountId !== account ||
    !input.token.trim() ||
    !Number.isSafeInteger(input.notBefore) ||
    input.notBefore < started - 30 * 60_000 ||
    input.notBefore > started
  )
    throw new Error("Invalid dev queue verification configuration")

  // Wait for a real scheduled message; never write synthetic healthy evidence.
  for (let attempt = 0; attempt < 32 && now() - started < 8 * 60_000; attempt++) {
    const response = await request(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${input.token}` },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined)
    if (response?.ok) {
      const value = await response.json().catch(() => undefined)
      const evidence = UsageQueueHeartbeatEvidenceSchema.safeParse(value)
      if (
        evidence.success &&
        evidence.data.stage === "dev" &&
        evidence.data.sentAt >= input.notBefore &&
        evidence.data.processedAt >= evidence.data.sentAt &&
        evidence.data.processedAt <= now() &&
        now() - evidence.data.processedAt <= 15 * 60_000
      ) {
        return { stage: "dev", version: 2, freshAfterDeployment: true, attempts: attempt + 1 }
      }
    } else if (response) {
      await response.body?.cancel().catch(() => undefined)
      if (response.status !== 404 && response.status !== 429 && response.status < 500) {
        throw new Error("Cloudflare refused dev queue readiness verification")
      }
    }
    if (attempt < 31) await sleep(15_000)
  }
  throw new Error("No fresh dev v2 queue heartbeat was observed after deployment")
}
