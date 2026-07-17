import { DurableObject } from "cloudflare:workers"
import { Resource } from "@mongolgpt/console-resource"
import {
  executeQuotaLedgerCommand,
  QuotaLedgerCommandSchema,
  QuotaLedgerRequestSchema,
  sweepQuotaLedger,
  UsageQueueEventSchema,
  type QuotaLedgerCommand,
  type QuotaLedgerStorage,
} from "@mongolgpt/console-core/quota.js"

type Env = {
  QUOTA_LEDGER: DurableObjectNamespace<QuotaLedger>
}

function json(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  })
}

function expirationOf(command: QuotaLedgerCommand) {
  if (command.type === "increment") {
    return command.changes.reduce<number | undefined>((earliest, change) => {
      if (change.expiresAt === null) return earliest
      return Math.min(earliest ?? change.expiresAt, change.expiresAt)
    }, undefined)
  }
  if (command.type === "claim") return command.expiresAt ?? undefined
  if (command.type === "ip-claim") return command.dailyExpiresAt
  if (command.type === "reserve" || command.type === "settle") return command.expiresAt
  return undefined
}

export class QuotaLedger extends DurableObject<Env> {
  async fetch(request: Request) {
    if (request.method !== "POST") return json({ error: "Зөвшөөрөгдөөгүй хүсэлт." }, 405)
    const parsed = QuotaLedgerCommandSchema.safeParse(await request.json().catch(() => undefined))
    if (!parsed.success) return json({ error: "Quota командын бүтэц буруу байна." }, 400)

    const result = await this.ctx.storage.transaction((transaction) =>
      executeQuotaLedgerCommand(transaction as unknown as QuotaLedgerStorage, parsed.data),
    )
    const expiration = expirationOf(parsed.data)
    if (expiration && expiration > Date.now()) {
      const current = await this.ctx.storage.getAlarm()
      if (current === null || expiration < current) await this.ctx.storage.setAlarm(expiration)
    }
    return json(result)
  }

  async alarm() {
    const next = await sweepQuotaLedger(this.ctx.storage as unknown as QuotaLedgerStorage)
    if (next) await this.ctx.storage.setAlarm(next)
  }
}

function secretsEqual(actual: string, expected: string) {
  const encoder = new TextEncoder()
  const left = encoder.encode(actual)
  const right = encoder.encode(expected)
  let mismatch = left.length ^ right.length
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index++) mismatch |= (left[index] ?? 0) ^ (right[index] ?? 0)
  return mismatch === 0
}

function authorized(request: Request) {
  const header = request.headers.get("authorization") ?? ""
  const expected = `Bearer ${Resource.QuotaServiceToken.value}`
  return secretsEqual(header, expected)
}

async function handler(request: Request, env: Env) {
  const url = new URL(request.url)
  if (url.pathname === "/health") {
    return json({ status: "ok", service: "quota", storage: "durable-objects", queue: "cloudflare-queues" })
  }
  if (!authorized(request)) return json({ error: "Дотоод үйлчилгээний зөвшөөрөл хүчингүй байна." }, 401)
  if (request.method !== "POST") return json({ error: "Зөвшөөрөгдөөгүй хүсэлт." }, 405)

  if (url.pathname === "/v1/ledger") {
    const parsed = QuotaLedgerRequestSchema.safeParse(await request.json().catch(() => undefined))
    if (!parsed.success) return json({ error: "Quota хүсэлтийн бүтэц буруу байна." }, 400)
    const id = env.QUOTA_LEDGER.idFromName(parsed.data.scope)
    const stub = env.QUOTA_LEDGER.get(id)
    return stub.fetch(
      new Request("https://quota.internal/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data.command),
      }),
    )
  }

  if (url.pathname === "/v1/usage") {
    const parsed = UsageQueueEventSchema.safeParse(await request.json().catch(() => undefined))
    if (!parsed.success) return json({ error: "Usage event-ийн бүтэц буруу байна." }, 400)
    await Resource.UsageQueue.send(parsed.data)
    return json({ queued: true }, 202)
  }

  return json({ error: "Үйлчилгээний зам олдсонгүй." }, 404)
}

export default {
  async fetch(request: Request, env: Env) {
    try {
      return await handler(request, env)
    } catch (error) {
      console.error("Quota service request failed", error)
      return json({ error: "Quota үйлчилгээ түр алдаатай байна." }, 500)
    }
  },
}
