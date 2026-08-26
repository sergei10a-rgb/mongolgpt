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
    throw new Error("Хязгаарын бүртгэлийн бэлэн байдлын хариу буруу байна")
  }
  const body: unknown = await response.json().catch(() => undefined)
  if (typeof body !== "object" || body === null || Array.isArray(body) || !("values" in body)) {
    throw new Error("Хязгаарын бүртгэлийн бэлэн байдлын өгөгдөл буруу байна")
  }
  const values = body.values
  if (typeof values !== "object" || values === null || Array.isArray(values) || !(key in values)) {
    throw new Error("Хязгаарын бүртгэлийн бэлэн байдлын утгууд буруу байна")
  }
  const value = values[key]
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Хязгаарын бүртгэлийн бэлэн байдлын тоолуур буруу байна")
  }
}
