import { and, asc, Database, eq, isNull, lt, lte, or, sql } from "./drizzle"
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

type Use = <T>(callback: (db: Database.TxOrDb) => Promise<T>) => Promise<T>
type Transaction = <T>(callback: (db: Database.TxOrDb) => Promise<T>) => Promise<T>
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
  dependencies: { transaction?: Transaction } = {},
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
  const transaction = dependencies.transaction ?? ((callback) => Database.transaction(callback))

  return transaction(async (db) => {
    const date = new Date(now)
    const event = parsed.success ? parsed.data : undefined
    const inserted = await db
      .insert(PaymentRecoveryTable)
      .values({
        id: `prc_${ulid()}`,
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
      .returning()
      .then((rows) => rows[0])

    if (inserted) {
      await writeSystemAudit(db, {
        recoveryID: inserted.id,
        action: "payment_recovery.dead_lettered",
        outcome: "failure",
        now: date,
        metadata: {
          status: inserted.status,
          validEvent: Boolean(event),
          provider: event?.event.provider ?? null,
        },
      })
      return recoveryState(inserted, true)
    }

    const existing = await db
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
      .limit(1)
      .then((rows) => rows[0])
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
  })
}

export async function processPaymentRecoveries(
  input: { now: number; limit?: number },
  dependencies: {
    apply: Apply
    use?: Use
    transaction?: Transaction
  },
) {
  const now = timestamp(input.now)
  const limit = input.limit ?? 50
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError("Төлбөрийн recovery багцын хязгаар буруу байна")
  }
  const use = dependencies.use ?? ((callback) => Database.use(callback))
  const transaction = dependencies.transaction ?? ((callback) => Database.transaction(callback))
  const date = new Date(now)
  const candidates = await use((db) =>
    db
      .select({ id: PaymentRecoveryTable.id })
      .from(PaymentRecoveryTable)
      .where(
        and(
          isNull(PaymentRecoveryTable.timeDeleted),
          lt(PaymentRecoveryTable.attempts, PAYMENT_RECOVERY_MAX_ATTEMPTS),
          or(
            and(eq(PaymentRecoveryTable.status, "pending"), lte(PaymentRecoveryTable.time_next_attempt, date)),
            and(eq(PaymentRecoveryTable.status, "processing"), lte(PaymentRecoveryTable.time_lease_expires, date)),
          ),
        ),
      )
      .orderBy(asc(PaymentRecoveryTable.timeCreated), asc(PaymentRecoveryTable.id))
      .limit(limit),
  )

  let resolved = 0
  let retried = 0
  let manualReview = 0
  let skipped = 0

  for (const candidate of candidates) {
    const claimed = await transaction((db) => claimRecovery(db, candidate.id, now))
    if (!claimed) {
      skipped++
      continue
    }

    const event = PaymentQueueEventSchema.safeParse(claimed.event)
    if (!event.success) {
      const marked = await transaction((db) =>
        markManualReview(db, claimed.id, claimed.attempts, "stored_event_invalid", date),
      )
      if (marked) manualReview++
      else skipped++
      continue
    }

    try {
      await dependencies.apply(event.data)
      const marked = await transaction((db) => markResolved(db, claimed.id, claimed.attempts, date))
      if (marked) resolved++
      else skipped++
    } catch {
      const marked = await transaction((db) => markApplyFailure(db, claimed.id, claimed.attempts, now))
      if (marked === "manual_review") manualReview++
      else if (marked === "pending") retried++
      else skipped++
    }
  }

  return { resolved, retried, manualReview, skipped, truncated: candidates.length === limit }
}

export async function retryPaymentRecoveryWithDb(db: Database.TxOrDb, input: { recoveryID: string; now: number }) {
  const date = new Date(timestamp(input.now))
  const current = await db
    .select({
      id: PaymentRecoveryTable.id,
      status: PaymentRecoveryTable.status,
      attempts: PaymentRecoveryTable.attempts,
      last_error_code: PaymentRecoveryTable.last_error_code,
      event: PaymentRecoveryTable.event,
    })
    .from(PaymentRecoveryTable)
    .where(and(eq(PaymentRecoveryTable.id, input.recoveryID), isNull(PaymentRecoveryTable.timeDeleted)))
    .limit(1)
    .then((rows) => rows[0])

  if (!current) throw new PaymentRecoveryRetryError("not_found")
  if (current.status !== "manual_review") {
    throw new PaymentRecoveryRetryError("invalid_state", current.status)
  }
  if (!PaymentQueueEventSchema.safeParse(current.event).success) {
    throw new PaymentRecoveryRetryError("invalid_event", current.status)
  }

  const updated = await db
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
    .returning({
      id: PaymentRecoveryTable.id,
      status: PaymentRecoveryTable.status,
      attempts: PaymentRecoveryTable.attempts,
      last_error_code: PaymentRecoveryTable.last_error_code,
      time_next_attempt: PaymentRecoveryTable.time_next_attempt,
    })
    .then((rows) => rows[0])

  if (!updated) throw new PaymentRecoveryRetryError("invalid_state", current.status)

  return {
    id: updated.id,
    status: updated.status,
    attempts: updated.attempts,
    previousStatus: current.status,
    previousAttempts: current.attempts,
    previousLastErrorCode: current.last_error_code,
    timeNextAttempt: updated.time_next_attempt,
  }
}

async function claimRecovery(db: Database.TxOrDb, id: string, now: number) {
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
    })
    .then((rows) => rows[0])
}

async function markResolved(db: Database.TxOrDb, id: string, attempts: number, now: Date) {
  const updated = await db
    .update(PaymentRecoveryTable)
    .set({
      status: "resolved",
      last_error_code: null,
      time_next_attempt: null,
      time_lease_expires: null,
      time_resolved: now,
      timeUpdated: now,
    })
    .where(
      and(
        eq(PaymentRecoveryTable.id, id),
        eq(PaymentRecoveryTable.status, "processing"),
        eq(PaymentRecoveryTable.attempts, attempts),
        isNull(PaymentRecoveryTable.timeDeleted),
      ),
    )
    .returning({ id: PaymentRecoveryTable.id })
    .then((rows) => rows[0])
  if (!updated) return false
  await writeSystemAudit(db, {
    recoveryID: id,
    action: "payment_recovery.resolved",
    outcome: "success",
    now,
    metadata: { attempts },
  })
  return true
}

async function markApplyFailure(db: Database.TxOrDb, id: string, attempts: number, now: number) {
  const manual = attempts >= PAYMENT_RECOVERY_MAX_ATTEMPTS
  const date = new Date(now)
  const status = manual ? "manual_review" : "pending"
  const updated = await db
    .update(PaymentRecoveryTable)
    .set({
      status,
      last_error_code: "payment_apply_failed",
      time_next_attempt: manual ? null : futureDate(now, retryDelay(attempts)),
      time_lease_expires: null,
      time_resolved: null,
      timeUpdated: date,
    })
    .where(
      and(
        eq(PaymentRecoveryTable.id, id),
        eq(PaymentRecoveryTable.status, "processing"),
        eq(PaymentRecoveryTable.attempts, attempts),
        isNull(PaymentRecoveryTable.timeDeleted),
      ),
    )
    .returning({ id: PaymentRecoveryTable.id })
    .then((rows) => rows[0])
  if (!updated) return undefined
  if (manual) {
    await writeSystemAudit(db, {
      recoveryID: id,
      action: "payment_recovery.manual_review",
      outcome: "failure",
      now: date,
      metadata: { attempts, errorCode: "payment_apply_failed" },
    })
  }
  return status
}

async function markManualReview(db: Database.TxOrDb, id: string, attempts: number, errorCode: string, now: Date) {
  const updated = await db
    .update(PaymentRecoveryTable)
    .set({
      status: "manual_review",
      last_error_code: errorCode,
      time_next_attempt: null,
      time_lease_expires: null,
      time_resolved: null,
      timeUpdated: now,
    })
    .where(
      and(
        eq(PaymentRecoveryTable.id, id),
        eq(PaymentRecoveryTable.status, "processing"),
        eq(PaymentRecoveryTable.attempts, attempts),
        isNull(PaymentRecoveryTable.timeDeleted),
      ),
    )
    .returning({ id: PaymentRecoveryTable.id })
    .then((rows) => rows[0])
  if (!updated) return false
  await writeSystemAudit(db, {
    recoveryID: id,
    action: "payment_recovery.manual_review",
    outcome: "failure",
    now,
    metadata: { attempts, errorCode },
  })
  return true
}

async function writeSystemAudit(
  db: Database.TxOrDb,
  input: {
    recoveryID: string
    action: string
    outcome: "success" | "failure"
    now: Date
    metadata: Record<string, string | number | boolean | null>
  },
) {
  await db.insert(AdminAuditLogTable).values({
    id: `aud_${ulid()}`,
    admin_id: null,
    actor_email: SYSTEM_ACTOR_EMAIL,
    action: input.action,
    target_type: "payment_recovery",
    target_id: input.recoveryID,
    outcome: input.outcome,
    request_id: `payment-recovery:${input.recoveryID}`,
    source_ip: null,
    user_agent: null,
    metadata: input.metadata,
    time_created: input.now,
  })
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
