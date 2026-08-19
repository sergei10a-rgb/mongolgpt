export async function verifyQuotaLedgerHealth(fetchLedger: (request: Request) => Promise<Response>) {
  const key = "system/health"
  const response = await fetchLedger(
    new Request("https://quota.internal/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "read", keys: [key] }),
    }),
  )
  if (!response.ok || response.headers.get("content-type")?.split(";", 1)[0] !== "application/json") {
    throw new Error("Quota ledger health response is invalid")
  }
  const body: unknown = await response.json().catch(() => undefined)
  if (typeof body !== "object" || body === null || Array.isArray(body) || !("values" in body)) {
    throw new Error("Quota ledger health payload is invalid")
  }
  const values = body.values
  if (typeof values !== "object" || values === null || Array.isArray(values) || !(key in values)) {
    throw new Error("Quota ledger health values are invalid")
  }
  const value = values[key]
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Quota ledger health counter is invalid")
  }
}
