import { z } from "zod"

const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const positiveInteger = integer.min(1)
const ledgerKey = z.string().trim().min(1).max(512)
const expiresAt = integer.nullable()
const reservationID = z.string().uuid()
const reservationEntry = z.object({
  counterKey: ledgerKey,
  persistedUsage: integer,
  amount: positiveInteger,
  limit: positiveInteger,
  expiresAt: positiveInteger,
})
const settlementEntry = z.object({
  counterKey: ledgerKey,
  actual: integer,
  expiresAt: positiveInteger,
})

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
    reservationID,
    persistedUsage: integer,
    amount: positiveInteger,
    limit: positiveInteger,
    expiresAt: integer,
  }),
  z.object({
    type: z.literal("settle"),
    counterKey: ledgerKey,
    reservationID,
    actual: integer,
    expiresAt: integer,
  }),
  z.object({
    type: z.literal("reserve-many"),
    reservationID,
    entries: z.array(reservationEntry).min(2).max(8),
  }),
  z.object({
    type: z.literal("settle-many"),
    reservationID,
    entries: z.array(settlementEntry).min(2).max(8),
  }),
  z.object({
    type: z.literal("deactivate"),
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
    country: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional(),
    continent: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional(),
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

export function planQuotaScope(workspaceID: string, invoiceID: string) {
  return `plan:${workspaceID}:${invoiceID}`
}

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

type SingleReservation = {
  counterKey: string
  persistedUsage: number
  amount: number
  limit: number
  expiresAt: number
}

type BatchReservation = {
  entries: Array<{
    counterKey: string
    persistedUsage: number
    amount: number
    limit: number
    expiresAt: number
  }>
  expiresAt: number
}

type Reservation = SingleReservation | BatchReservation

const COUNTER_PREFIX = "counter/"
const RESERVATION_PREFIX = "reservation/"
const DEACTIVATED_KEY = "state/deactivated"

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

function uniqueCounterKeys(entries: ReadonlyArray<{ counterKey: string }>) {
  const keys = new Set(entries.map((entry) => entry.counterKey))
  if (keys.size !== entries.length) throw new Error("Quota reservation contains duplicate counters")
}

function isBatchReservation(reservation: Reservation): reservation is BatchReservation {
  return "entries" in reservation
}

function sameSingleReservation(
  reservation: SingleReservation,
  command: { counterKey: string; persistedUsage: number; amount: number; limit: number; expiresAt: number },
) {
  return (
    reservation.counterKey === command.counterKey &&
    reservation.persistedUsage === command.persistedUsage &&
    reservation.amount === command.amount &&
    reservation.limit === command.limit &&
    reservation.expiresAt === command.expiresAt
  )
}

function sameBatchReservation(
  reservation: BatchReservation,
  entries: ReadonlyArray<{
    counterKey: string
    persistedUsage: number
    amount: number
    limit: number
    expiresAt: number
  }>,
) {
  if (reservation.entries.length !== entries.length) return false
  return reservation.entries.every((stored, index) => {
    const replay = entries[index]
    return (
      stored.counterKey === replay?.counterKey &&
      stored.persistedUsage === replay.persistedUsage &&
      stored.amount === replay.amount &&
      stored.limit === replay.limit &&
      stored.expiresAt === replay.expiresAt
    )
  })
}

function sameBatchSettlement(
  reservation: BatchReservation,
  entries: ReadonlyArray<{ counterKey: string; expiresAt: number }>,
) {
  if (reservation.entries.length !== entries.length) return false
  return reservation.entries.every((stored, index) => {
    const settlement = entries[index]
    return stored.counterKey === settlement?.counterKey && stored.expiresAt === settlement.expiresAt
  })
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
  if (command.type === "deactivate") {
    await storage.put(DEACTIVATED_KEY, true)
    return { deactivated: true }
  }

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
    if (await storage.get<boolean>(DEACTIVATED_KEY)) return { allowed: false, deactivated: true, value: 0 }
    const reservationKey = reservationStorageKey(command.reservationID)
    const existing = await storage.get<Reservation>(reservationKey)
    const counter = await readCounter(storage, command.counterKey, now)
    if (existing && existing.expiresAt > now) {
      if (isBatchReservation(existing) || !sameSingleReservation(existing, command)) {
        throw new Error("Quota reservation scope mismatch")
      }
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
      persistedUsage: command.persistedUsage,
      amount: command.amount,
      limit: command.limit,
      expiresAt: command.expiresAt,
    })
    return { allowed: true, value: updated }
  }

  if (command.type === "reserve-many") {
    if (await storage.get<boolean>(DEACTIVATED_KEY)) return { allowed: false, deactivated: true, values: {} }
    uniqueCounterKeys(command.entries)
    const reservationKey = reservationStorageKey(command.reservationID)
    const existing = await storage.get<Reservation>(reservationKey)
    const counters = await Promise.all(
      command.entries.map(async (entry) => ({
        entry,
        counter: await readCounter(storage, entry.counterKey, now),
      })),
    )
    if (existing && existing.expiresAt > now) {
      if (!isBatchReservation(existing) || !sameBatchReservation(existing, command.entries)) {
        throw new Error("Quota reservation scope mismatch")
      }
      return {
        allowed: true,
        values: Object.fromEntries(counters.map(({ entry, counter }) => [entry.counterKey, counter.value])),
      }
    }
    if (existing) await storage.delete(reservationKey)

    const prepared = counters.map(({ entry, counter }) => {
      const accounted = Math.max(counter.value, entry.persistedUsage)
      return {
        entry,
        counter,
        accounted,
        updated: safeAdd(accounted, entry.amount),
      }
    })
    const blocked = prepared.find(({ entry, updated }) => updated > entry.limit)
    if (blocked) {
      for (const item of prepared) {
        if (item.accounted > item.counter.value) {
          await writeCounter(storage, item.entry.counterKey, item.accounted, item.entry.expiresAt)
        }
      }
      return {
        allowed: false,
        blockedKey: blocked.entry.counterKey,
        values: Object.fromEntries(prepared.map((item) => [item.entry.counterKey, item.accounted])),
      }
    }

    for (const item of prepared) {
      await writeCounter(storage, item.entry.counterKey, item.updated, item.entry.expiresAt)
    }
    await storage.put<BatchReservation>(reservationKey, {
      entries: command.entries.map(({ counterKey, persistedUsage, amount, limit, expiresAt }) => ({
        counterKey,
        persistedUsage,
        amount,
        limit,
        expiresAt,
      })),
      expiresAt: Math.max(...command.entries.map((entry) => entry.expiresAt)),
    })
    return {
      allowed: true,
      values: Object.fromEntries(prepared.map((item) => [item.entry.counterKey, item.updated])),
    }
  }

  if (command.type === "settle-many") {
    uniqueCounterKeys(command.entries)
    const reservationKey = reservationStorageKey(command.reservationID)
    const reservation = await storage.get<Reservation>(reservationKey)
    const current = async () =>
      Object.fromEntries(
        await Promise.all(
          command.entries.map(async (entry) => [
            entry.counterKey,
            (await readCounter(storage, entry.counterKey, now)).value,
          ]),
        ),
      )
    if (!reservation || reservation.expiresAt <= now) {
      if (reservation) await storage.delete(reservationKey)
      return { values: await current() }
    }
    if (await storage.get<boolean>(DEACTIVATED_KEY)) {
      await storage.delete(reservationKey)
      return { deactivated: true, values: await current() }
    }
    if (!isBatchReservation(reservation) || !sameBatchSettlement(reservation, command.entries)) {
      throw new Error("Quota reservation scope mismatch")
    }

    const overrun = command.entries.find((entry) => {
      const reserved = reservation.entries.find((item) => item.counterKey === entry.counterKey)
      if (!reserved) throw new Error("Quota reservation scope mismatch")
      return entry.actual > reserved.amount
    })
    if (overrun) {
      await storage.put(DEACTIVATED_KEY, true)
      await storage.delete(reservationKey)
      return {
        deactivated: true,
        overrun: true,
        blockedKey: overrun.counterKey,
        values: await current(),
      }
    }

    const values: Record<string, number> = {}
    for (const entry of command.entries) {
      const reserved = reservation.entries.find((item) => item.counterKey === entry.counterKey)
      if (!reserved) throw new Error("Quota reservation scope mismatch")
      const counter = await readCounter(storage, entry.counterKey, now)
      const value = safeAdd(Math.max(0, counter.value - reserved.amount), entry.actual)
      await writeCounter(storage, entry.counterKey, value, entry.expiresAt)
      values[entry.counterKey] = value
    }
    await storage.delete(reservationKey)
    return { values }
  }

  const reservationKey = reservationStorageKey(command.reservationID)
  const reservation = await storage.get<Reservation>(reservationKey)
  const counter = await readCounter(storage, command.counterKey, now)
  if (!reservation || reservation.expiresAt <= now) {
    if (reservation) await storage.delete(reservationKey)
    return { value: counter.value }
  }
  if (isBatchReservation(reservation) || reservation.counterKey !== command.counterKey) {
    throw new Error("Quota reservation scope mismatch")
  }

  if (command.actual > reservation.amount) {
    await storage.put(DEACTIVATED_KEY, true)
    await storage.delete(reservationKey)
    return { deactivated: true, overrun: true, value: counter.value }
  }

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
