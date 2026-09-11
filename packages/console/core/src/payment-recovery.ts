import { and, asc, Database, eq, exists, isNull, lt, lte, or, sql, type SQL } from "./drizzle"
import { paymentBatchGuard, type PaymentBatchDatabase, type PaymentBatchQuery } from "./payment-ledger"
import { PaymentQueueEventSchema, type PaymentQueueEvent } from "./payment-queue"
import { AdminAuditLogTable } from "./schema/admin.sql"
import { PaymentRecoveryTable } from "./schema/billing.sql"
import { ulid } from "ulid"

export const PAYMENT_RECOVERY_MAX_ATTEMPTS = 6
export const PAYMENT_RECOVERY_LEASE_MS = 5 * 60 * 1_000
export const PAYMENT_RECOVERY_BASE_RETRY_MS = 5 * 60 * 1_000
export const PAYMENT_RECOVERY_MAX_RETRY_MS = 6 * 60 * 60 * 1_000

const MAX_FINGERPRINT_INPUT_BYTES = 1_000_000
const SYSTEM_ACTOR_EMAIL = "system@mgpt.mn"

type Apply = (event: PaymentQueueEvent) => Promise<unknown>

export class PaymentRecoveryRetryError extends Error {
  constructor(
    readonly code: "not_found" | "invalid_state" | "invalid_event",
    readonly currentStatus?: string,
  ) {
    super(code)
    this.name = "PaymentRecoveryRetryError"
  }
}

export async function recordPaymentDeadLetter(
  input: { body: unknown; now?: number; trustedMessageHash?: string },
  dependencies: { batch?: typeof Database.batch } = {},
) {
  const now = timestamp(input.now ?? Date.now())
  const parsed = PaymentQueueEventSchema.safeParse(input.body)
  const calculatedHash = await paymentRecoveryFingerprint(parsed.success ? parsed.data : input.body)
  const messageHash = input.trustedMessageHash ?? calculatedHash
  if (!/^[a-f0-9]{64}$/.test(messageHash)) {
    throw new TypeError("Төлбөрийн recovery message hash буруу байна")
  }
  if (parsed.success && messageHash !== calculatedHash) {
    throw new Error("Төлбөрийн recovery event-ийн message hash зөрлөө")
  }
  const batch = dependencies.batch ?? Database.batch
  const date = new Date(now)
  const event = parsed.success ? parsed.data : undefined
  const id = `prc_${ulid()}`
  const [[inserted], , [existing]] = await batch((db) => [
    db
      .insert(PaymentRecoveryTable)
      .values({
        id,
        message_hash: messageHash,
        provider: event?.event.provider,
        merchant_account_id: event?.event.merchantAccountID,
        external_event_id: event?.event.externalEventID,
        external_invoice_id: event?.event.externalInvoiceID,
        payload_hash: event?.event.payloadHash,
        event,
        status: event ? "pending" : "manual_review",
        attempts: 0,
        last_error_code: event ? null : "invalid_payment_queue_event",
        time_next_attempt: event ? date : null,
        time_lease_expires: null,
        time_resolved: null,
        timeCreated: date,
        timeUpdated: date,
      })
      .onConflictDoNothing()
      .returning(),
    systemAuditQuery(
      db,
      {
        recoveryID: id,
        action: "payment_recovery.dead_lettered",
        outcome: "failure",
        now: date,
        metadata: {
          status: event ? "pending" : "manual_review",
          validEvent: Boolean(event),
          provider: event?.event.provider ?? null,
        },
      },
      eq(PaymentRecoveryTable.id, id),
    ),
    db
      .select()
      .from(PaymentRecoveryTable)
      .where(
        event
          ? or(
              eq(PaymentRecoveryTable.message_hash, messageHash),
              and(
                eq(PaymentRecoveryTable.provider, event.event.provider),
                eq(PaymentRecoveryTable.merchant_account_id, event.event.merchantAccountID),
                eq(PaymentRecoveryTable.external_event_id, event.event.externalEventID),
              ),
            )
          : eq(PaymentRecoveryTable.message_hash, messageHash),
      )
      .limit(1),
  ])
  if (inserted) return recoveryState(inserted, true)
  if (!existing) throw new Error("Төлбөрийн recovery бүртгэлийн давхардлыг баталгаажуулж чадсангүй")
  const storedEvent = event ? PaymentQueueEventSchema.safeParse(existing.event) : undefined
  if (
    event &&
    (!storedEvent?.success ||
      existing.payload_hash !== event.event.payloadHash ||
      !samePaymentEvent(storedEvent.data.event, event.event))
  ) {
    throw new Error("Төлбөрийн recovery event өмнөх event-тэй зөрчилдөж байна")
  }
  return recoveryState(existing, false)
}

export async function processPaymentRecoveries(
  input: { now: number; limit?: number },
  dependencies: {
    apply: Apply
    batch?: typeof Database.batch
  },
) {
  const now = timestamp(input.now)
  const limit = input.limit ?? 50
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError("Төлбөрийн recovery багцын хязгаар буруу байна")
  }
  const batch = dependencies.batch ?? Database.batch
  const date = new Date(now)
  const [candidates] = await batch((db) => [
    db
      .select({
        id: PaymentRecoveryTable.id,
        status: PaymentRecoveryTable.status,
        attempts: PaymentRecoveryTable.attempts,
        timeLeaseExpires: PaymentRecoveryTable.time_lease_expires,
        timeUpdated: PaymentRecoveryTable.timeUpdated,
      })
      .from(PaymentRecoveryTable)
      .where(
        and(
          isNull(PaymentRecoveryTable.timeDeleted),
          or(
            and(eq(PaymentRecoveryTable.status, "pending"), lte(PaymentRecoveryTable.time_next_attempt, date)),
            and(eq(PaymentRecoveryTable.status, "processing"), lte(PaymentRecoveryTable.time_lease_expires, date)),
          ),
        ),
      )
      .orderBy(asc(PaymentRecoveryTable.timeCreated), asc(PaymentRecoveryTable.id))
      .limit(limit),
  ])

  let resolved = 0
  let retried = 0
  let manualReview = 0
  let skipped = 0

  for (const candidate of candidates) {
    if (candidate.attempts >= PAYMENT_RECOVERY_MAX_ATTEMPTS) {
      const marked = await markRecovery(batch, candidate, "manual_review", date, "recovery_attempts_exhausted")
      if (marked) manualReview++
      else skipped++
      continue
    }
    const [[claimed]] = await batch((db) => [claimRecovery(db, candidate.id, now)])
    if (!claimed) {
      skipped++
      continue
    }

    const event = PaymentQueueEventSchema.safeParse(claimed.event)
    if (!event.success) {
      const marked = await markRecovery(batch, claimed, "manual_review", date, "stored_event_invalid")
      if (marked) manualReview++
      else skipped++
      continue
    }

    try {
      await dependencies.apply(event.data)
      const marked = await markRecovery(batch, claimed, "resolved", date)
      if (marked) resolved++
      else skipped++
    } catch {
      const status = claimed.attempts >= PAYMENT_RECOVERY_MAX_ATTEMPTS ? "manual_review" : "pending"
      const marked = await markRecovery(batch, claimed, status, date, "payment_apply_failed")
      if (marked && status === "manual_review") manualReview++
      else if (marked) retried++
      else skipped++
    }
  }

  return { resolved, retried, manualReview, skipped, truncated: candidates.length === limit }
}

type RecoveryRetryResult = {
  id: string
  status: "pending"
  attempts: 0
  previousStatus: "manual_review"
  previousAttempts: number
  previousLastErrorCode: string | null
  timeNextAttempt: Date
}

export async function retryPaymentRecovery(
  input: { recoveryID: string; now: number },
  dependencies: {
    batch?: typeof Database.batch
    effect?: (db: PaymentBatchDatabase, result: RecoveryRetryResult) => readonly PaymentBatchQuery[]
  } = {},
) {
  const batch = dependencies.batch ?? Database.batch
  const date = new Date(timestamp(input.now))
  const [[current]] = await batch((db) => [
    db
      .select({
        id: PaymentRecoveryTable.id,
        status: PaymentRecoveryTable.status,
        attempts: PaymentRecoveryTable.attempts,
        last_error_code: PaymentRecoveryTable.last_error_code,
        event: PaymentRecoveryTable.event,
        timeUpdated: PaymentRecoveryTable.timeUpdated,
      })
      .from(PaymentRecoveryTable)
      .where(and(eq(PaymentRecoveryTable.id, input.recoveryID), isNull(PaymentRecoveryTable.timeDeleted)))
      .limit(1),
  ])

  if (!current) throw new PaymentRecoveryRetryError("not_found")
  if (current.status !== "manual_review") {
    throw new PaymentRecoveryRetryError("invalid_state", current.status)
  }
  if (!PaymentQueueEventSchema.safeParse(current.event).success) {
    throw new PaymentRecoveryRetryError("invalid_event", current.status)
  }

  const result: RecoveryRetryResult = {
    id: current.id,
    status: "pending",
    attempts: 0,
    previousStatus: "manual_review",
    previousAttempts: current.attempts,
    previousLastErrorCode: current.last_error_code,
    timeNextAttempt: date,
  }
  await batch((db) => [
    paymentBatchGuard(
      db,
      exists(
        db
          .select({ id: PaymentRecoveryTable.id })
          .from(PaymentRecoveryTable)
          .where(
            and(
              eq(PaymentRecoveryTable.id, current.id),
              eq(PaymentRecoveryTable.status, "manual_review"),
              eq(PaymentRecoveryTable.attempts, current.attempts),
              sql`${PaymentRecoveryTable.timeUpdated} is ${current.timeUpdated?.getTime() ?? null}`,
              sql`${PaymentRecoveryTable.last_error_code} is ${current.last_error_code}`,
              eq(PaymentRecoveryTable.event, current.event),
              isNull(PaymentRecoveryTable.timeDeleted),
            ),
          ),
      ),
    ),
    db
      .update(PaymentRecoveryTable)
      .set({
        status: "pending",
        attempts: 0,
        last_error_code: null,
        time_next_attempt: date,
        time_lease_expires: null,
        time_resolved: null,
        timeUpdated: date,
      })
      .where(
        and(
          eq(PaymentRecoveryTable.id, input.recoveryID),
          eq(PaymentRecoveryTable.status, "manual_review"),
          isNull(PaymentRecoveryTable.timeDeleted),
        ),
      )
      .returning(),
    ...(dependencies.effect?.(db, result) ?? []),
  ])
  return result
}

function claimRecovery(db: PaymentBatchDatabase, id: string, now: number) {
  const date = new Date(now)
  return db
    .update(PaymentRecoveryTable)
    .set({
      status: "processing",
      attempts: sql`${PaymentRecoveryTable.attempts} + 1`,
      last_error_code: null,
      time_next_attempt: null,
      time_lease_expires: futureDate(now, PAYMENT_RECOVERY_LEASE_MS),
      time_resolved: null,
      timeUpdated: date,
    })
    .where(
      and(
        eq(PaymentRecoveryTable.id, id),
        isNull(PaymentRecoveryTable.timeDeleted),
        lt(PaymentRecoveryTable.attempts, PAYMENT_RECOVERY_MAX_ATTEMPTS),
        or(
          and(eq(PaymentRecoveryTable.status, "pending"), lte(PaymentRecoveryTable.time_next_attempt, date)),
          and(eq(PaymentRecoveryTable.status, "processing"), lte(PaymentRecoveryTable.time_lease_expires, date)),
        ),
      ),
    )
    .returning({
      id: PaymentRecoveryTable.id,
      attempts: PaymentRecoveryTable.attempts,
      event: PaymentRecoveryTable.event,
      timeLeaseExpires: PaymentRecoveryTable.time_lease_expires,
      status: PaymentRecoveryTable.status,
      timeUpdated: PaymentRecoveryTable.timeUpdated,
    })
}

type RecoveryClaim = {
  id: string
  status: typeof PaymentRecoveryTable.$inferSelect.status
  attempts: number
  timeLeaseExpires: Date | null
  timeUpdated: Date | null
}

async function markRecovery(
  batch: typeof Database.batch,
  claim: RecoveryClaim,
  status: "resolved" | "pending" | "manual_review",
  now: Date,
  errorCode?: string,
) {
  const condition = and(
    eq(PaymentRecoveryTable.id, claim.id),
    eq(PaymentRecoveryTable.status, claim.status),
    eq(PaymentRecoveryTable.attempts, claim.attempts),
    sql`${PaymentRecoveryTable.time_lease_expires} is ${claim.timeLeaseExpires?.getTime() ?? null}`,
    sql`${PaymentRecoveryTable.timeUpdated} is ${claim.timeUpdated?.getTime() ?? null}`,
    isNull(PaymentRecoveryTable.timeDeleted),
  )!
  const update = (db: PaymentBatchDatabase) =>
    db
      .update(PaymentRecoveryTable)
      .set({
        status,
        last_error_code: status === "resolved" ? null : errorCode,
        time_next_attempt: status === "pending" ? futureDate(now.getTime(), retryDelay(claim.attempts)) : null,
        time_lease_expires: null,
        time_resolved: status === "resolved" ? now : null,
        timeUpdated: now,
      })
      .where(condition)
      .returning({ id: PaymentRecoveryTable.id })
  if (status === "pending") {
    const [updated] = await batch((db) => [update(db)])
    return updated.length === 1
  }
  const [, updated] = await batch((db) => [
    systemAuditQuery(
      db,
      {
        recoveryID: claim.id,
        action: status === "resolved" ? "payment_recovery.resolved" : "payment_recovery.manual_review",
        outcome: status === "resolved" ? "success" : "failure",
        now,
        metadata: { attempts: claim.attempts, ...(errorCode ? { errorCode } : {}) },
      },
      condition,
    ),
    update(db),
  ])
  return updated.length === 1
}

function systemAuditQuery(
  db: PaymentBatchDatabase,
  input: {
    recoveryID: string
    action: string
    outcome: "success" | "failure"
    now: Date
    metadata: Record<string, string | number | boolean | null>
  },
  condition: SQL,
) {
  // The audit and state transition share one D1 batch and the same ownership predicate.
  return db.insert(AdminAuditLogTable).select(
    db
      .select({
        id: sql<string>`${`aud_${ulid()}`}`.as("id"),
        admin_id: sql<null>`null`.as("admin_id"),
        actor_email: sql<string>`${SYSTEM_ACTOR_EMAIL}`.as("actor_email"),
        action: sql<string>`${input.action}`.as("action"),
        target_type: sql<string>`'payment_recovery'`.as("target_type"),
        target_id: sql<string>`${input.recoveryID}`.as("target_id"),
        outcome: sql<"success" | "failure">`${input.outcome}`.as("outcome"),
        request_id: sql<string>`${`payment-recovery:${input.recoveryID}`}`.as("request_id"),
        source_ip: sql<null>`null`.as("source_ip"),
        user_agent: sql<null>`null`.as("user_agent"),
        metadata: sql<typeof input.metadata>`${JSON.stringify(input.metadata)}`.as("metadata"),
        time_created: sql<Date>`${input.now.getTime()}`.as("time_created"),
      })
      .from(PaymentRecoveryTable)
      .where(condition)
      .limit(1),
  )
}

export async function paymentRecoveryFingerprint(value: unknown) {
  const serialized = safeFingerprintInput(value)
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`payment-recovery-v1:${serialized}`))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function safeFingerprintInput(value: unknown) {
  let serialized: string
  try {
    serialized = `${Object.prototype.toString.call(value)}:${JSON.stringify(value) ?? String(value)}`
  } catch {
    serialized = `${Object.prototype.toString.call(value)}:unserializable`
  }
  const bytes = new TextEncoder().encode(serialized)
  if (bytes.byteLength <= MAX_FINGERPRINT_INPUT_BYTES) return serialized
  const prefix = new TextDecoder().decode(bytes.slice(0, MAX_FINGERPRINT_INPUT_BYTES))
  return `${prefix}:truncated:${bytes.byteLength}`
}

function retryDelay(attempts: number) {
  const exponent = Math.max(0, attempts - 1)
  return Math.min(PAYMENT_RECOVERY_MAX_RETRY_MS, PAYMENT_RECOVERY_BASE_RETRY_MS * 2 ** exponent)
}

function samePaymentEvent(left: PaymentQueueEvent["event"], right: PaymentQueueEvent["event"]) {
  return (
    left.id === right.id &&
    left.provider === right.provider &&
    left.merchantAccountID === right.merchantAccountID &&
    left.externalEventID === right.externalEventID &&
    left.externalInvoiceID === right.externalInvoiceID &&
    left.externalPaymentID === right.externalPaymentID &&
    left.amount === right.amount &&
    left.currency === right.currency &&
    left.type === right.type &&
    left.payloadHash === right.payloadHash &&
    left.occurredAt === right.occurredAt
  )
}

function futureDate(now: number, delay: number) {
  return new Date(timestamp(now + delay))
}

function recoveryState(row: typeof PaymentRecoveryTable.$inferSelect, changed: boolean) {
  return {
    id: row.id,
    status: row.status,
    attempts: row.attempts,
    validEvent: row.event !== null,
    changed,
  }
}

function timestamp(value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 8_640_000_000_000_000) {
    throw new TypeError("Төлбөрийн recovery хугацаа буруу байна")
  }
  return value
}
