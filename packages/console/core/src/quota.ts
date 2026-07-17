import { z } from "zod"

const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const positiveInteger = integer.min(1)
const ledgerKey = z.string().trim().min(1).max(512)
const expiresAt = integer.nullable()

export const QuotaLedgerCommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("read"),
    keys: z.array(ledgerKey).min(1).max(64),
  }),
  z.object({
    type: z.literal("increment"),
    changes: z
      .array(
        z.object({
          key: ledgerKey,
          amount: positiveInteger,
          expiresAt,
        }),
      )
      .min(1)
      .max(64),
  }),
  z.object({
    type: z.literal("claim"),
    key: ledgerKey,
    amount: positiveInteger,
    limit: positiveInteger,
    expiresAt,
  }),
  z.object({
    type: z.literal("ip-claim"),
    dailyKey: ledgerKey,
    lifetimeKey: ledgerKey.nullable(),
    dailyLimit: positiveInteger,
    dailyExpiresAt: integer,
  }),
  z.object({
    type: z.literal("reserve"),
    counterKey: ledgerKey,
    reservationID: z.string().uuid(),
    persistedUsage: integer,
    amount: positiveInteger,
    limit: positiveInteger,
    expiresAt: integer,
  }),
  z.object({
    type: z.literal("settle"),
    counterKey: ledgerKey,
    reservationID: z.string().uuid(),
    actual: integer,
    expiresAt: integer,
  }),
])

export const QuotaLedgerRequestSchema = z.object({
  scope: ledgerKey,
  command: QuotaLedgerCommandSchema,
})

const optionalUsageInteger = integer.optional()

export const UsageQueueEventSchema = z.object({
  version: z.literal(1),
  id: z.string().trim().min(1).max(30),
  workspaceID: z.string().trim().min(1).max(30),
  userID: z.string().trim().min(1).max(30),
  timeCreated: integer,
  workspaceCost: integer,
  userCost: integer,
  usage: z.object({
    model: z.string().trim().min(1).max(255),
    provider: z.string().trim().min(1).max(255),
    inputTokens: integer,
    outputTokens: integer,
    reasoningTokens: optionalUsageInteger,
    cacheReadTokens: optionalUsageInteger,
    cacheWrite5mTokens: optionalUsageInteger,
    cacheWrite1hTokens: optionalUsageInteger,
    cost: integer,
    inputCost: optionalUsageInteger,
    outputCost: optionalUsageInteger,
    cacheReadCost: optionalUsageInteger,
    cacheWriteCost: optionalUsageInteger,
    country: z.string().regex(/^[A-Z]{2}$/).optional(),
    continent: z.string().regex(/^[A-Z]{2}$/).optional(),
    keyID: z.string().trim().min(1).max(30).optional(),
    sessionID: z.string().max(30).optional(),
    enrichment: z
      .object({
        plan: z.enum(["basic", "pro", "max", "byok", "legacy-lite", "balance"]),
      })
      .optional(),
  }),
})

export type QuotaLedgerCommand = z.infer<typeof QuotaLedgerCommandSchema>
export type QuotaLedgerRequest = z.infer<typeof QuotaLedgerRequestSchema>
export type UsageQueueEvent = z.infer<typeof UsageQueueEventSchema>

export interface QuotaLedgerStorage {
  get<T>(key: string): Promise<T | undefined>
  put<T>(key: string, value: T): Promise<void>
  delete(key: string): Promise<unknown>
  list<T>(options: { prefix: string }): Promise<Map<string, T>>
}

type Counter = {
  value: number
  expiresAt: number | null
}

type Reservation = {
  counterKey: string
  amount: number
  expiresAt: number
}

const COUNTER_PREFIX = "counter/"
const RESERVATION_PREFIX = "reservation/"

function counterStorageKey(key: string) {
  return `${COUNTER_PREFIX}${key}`
}

function reservationStorageKey(id: string) {
  return `${RESERVATION_PREFIX}${id}`
}

function safeAdd(left: number, right: number) {
  const result = left + right
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("Quota ledger counter overflow")
  return result
}

async function readCounter(storage: QuotaLedgerStorage, key: string, now: number) {
  const storedKey = counterStorageKey(key)
  const counter = await storage.get<Counter>(storedKey)
  if (!counter) return { value: 0, expiresAt: null as number | null }
  if (counter.expiresAt !== null && counter.expiresAt <= now) {
    await storage.delete(storedKey)
    return { value: 0, expiresAt: null as number | null }
  }
  return counter
}

async function writeCounter(storage: QuotaLedgerStorage, key: string, value: number, expiration: number | null) {
  await storage.put<Counter>(counterStorageKey(key), {
    value,
    expiresAt: expiration,
  })
}

export async function executeQuotaLedgerCommand(
  storage: QuotaLedgerStorage,
  command: QuotaLedgerCommand,
  now = Date.now(),
): Promise<Record<string, unknown>> {
  if (command.type === "read") {
    const values = Object.fromEntries(
      await Promise.all(command.keys.map(async (key) => [key, (await readCounter(storage, key, now)).value] as const)),
    )
    return { values }
  }

  if (command.type === "increment") {
    const values: Record<string, number> = {}
    for (const change of command.changes) {
      const counter = await readCounter(storage, change.key, now)
      const value = safeAdd(counter.value, change.amount)
      await writeCounter(storage, change.key, value, change.expiresAt)
      values[change.key] = value
    }
    return { values }
  }

  if (command.type === "claim") {
    const counter = await readCounter(storage, command.key, now)
    const value = safeAdd(counter.value, command.amount)
    if (value > command.limit) return { allowed: false, value: counter.value }
    await writeCounter(storage, command.key, value, command.expiresAt)
    return { allowed: true, value }
  }

  if (command.type === "ip-claim") {
    const daily = await readCounter(storage, command.dailyKey, now)
    const lifetime = command.lifetimeKey ? await readCounter(storage, command.lifetimeKey, now) : undefined
    const isNew = lifetime ? lifetime.value < command.dailyLimit * 7 : false
    const limit = isNew ? command.dailyLimit * 2 : command.dailyLimit
    if (daily.value >= limit) {
      return {
        allowed: false,
        isNew,
        daily: daily.value,
        lifetime: lifetime?.value ?? 0,
      }
    }

    const dailyValue = safeAdd(daily.value, 1)
    await writeCounter(storage, command.dailyKey, dailyValue, command.dailyExpiresAt)
    let lifetimeValue = lifetime?.value ?? 0
    if (isNew && command.lifetimeKey) {
      lifetimeValue = safeAdd(lifetimeValue, 1)
      await writeCounter(storage, command.lifetimeKey, lifetimeValue, null)
    }
    return {
      allowed: true,
      isNew,
      daily: dailyValue,
      lifetime: lifetimeValue,
    }
  }

  if (command.type === "reserve") {
    const reservationKey = reservationStorageKey(command.reservationID)
    const existing = await storage.get<Reservation>(reservationKey)
    const counter = await readCounter(storage, command.counterKey, now)
    if (existing && existing.expiresAt > now) {
      if (existing.counterKey !== command.counterKey) throw new Error("Quota reservation scope mismatch")
      return { allowed: true, value: counter.value }
    }
    if (existing) await storage.delete(reservationKey)

    const accounted = Math.max(counter.value, command.persistedUsage)
    if (accounted > counter.value) await writeCounter(storage, command.counterKey, accounted, command.expiresAt)
    const updated = safeAdd(accounted, command.amount)
    if (updated > command.limit) return { allowed: false, value: accounted }

    await writeCounter(storage, command.counterKey, updated, command.expiresAt)
    await storage.put<Reservation>(reservationKey, {
      counterKey: command.counterKey,
      amount: command.amount,
      expiresAt: command.expiresAt,
    })
    return { allowed: true, value: updated }
  }

  const reservationKey = reservationStorageKey(command.reservationID)
  const reservation = await storage.get<Reservation>(reservationKey)
  const counter = await readCounter(storage, command.counterKey, now)
  if (!reservation || reservation.expiresAt <= now) {
    if (reservation) await storage.delete(reservationKey)
    return { value: counter.value }
  }
  if (reservation.counterKey !== command.counterKey) throw new Error("Quota reservation scope mismatch")

  const updated = safeAdd(Math.max(0, counter.value - reservation.amount), command.actual)
  await writeCounter(storage, command.counterKey, updated, command.expiresAt)
  await storage.delete(reservationKey)
  return { value: updated }
}

export async function sweepQuotaLedger(storage: QuotaLedgerStorage, now = Date.now()) {
  const [counters, reservations] = await Promise.all([
    storage.list<Counter>({ prefix: COUNTER_PREFIX }),
    storage.list<Reservation>({ prefix: RESERVATION_PREFIX }),
  ])
  let nextExpiration: number | undefined
  for (const [key, value] of [...counters, ...reservations]) {
    const expiration = value.expiresAt
    if (expiration === null) continue
    if (expiration <= now) {
      await storage.delete(key)
      continue
    }
    nextExpiration = Math.min(nextExpiration ?? expiration, expiration)
  }
  return nextExpiration
}
