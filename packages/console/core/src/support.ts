import { and, asc, count, desc, eq, gte, isNull, lt, notInArray, or } from "drizzle-orm"
import { ulid } from "ulid"
import { z } from "zod"
import { Database } from "./drizzle"
import { AccountTable } from "./schema/account.sql"
import { SupportMessageTable, SupportTicketTable } from "./schema/support.sql"
import { UserTable } from "./schema/user.sql"

const CategorySchema = z.enum(["account", "billing", "technical", "feedback", "other"])
const TicketIDSchema = z.string().regex(/^spt_[0-9A-HJKMNP-TV-Z]{26}$/)

export const SupportTicketInputSchema = z
  .object({
    accountID: z.string().trim().min(1).max(30),
    requesterEmail: z.string().trim().toLowerCase().email().max(254),
    workspaceID: z.string().trim().min(1).max(30).optional(),
    subject: z.string().trim().min(1).max(160),
    category: CategorySchema,
    message: z.string().trim().min(1).max(5_000),
  })
  .strict()

export const SupportReplyInputSchema = z
  .object({
    accountID: z.string().trim().min(1).max(30),
    ticketID: TicketIDSchema,
    message: z.string().trim().min(1).max(5_000),
    expectedLockVersion: z.number().int().nonnegative(),
  })
  .strict()

export const SupportTicketResultSchema = z.object({
  id: TicketIDSchema,
  status: z.enum(["open", "pending_user", "pending_support", "resolved", "closed"]),
  lockVersion: z.number().int().nonnegative(),
})

export type SupportTicketInput = z.input<typeof SupportTicketInputSchema>
export type SupportReplyInput = z.input<typeof SupportReplyInputSchema>
export type SupportTicketResult = z.output<typeof SupportTicketResultSchema>
export type SupportErrorCode =
  | "not_found"
  | "forbidden"
  | "suspended"
  | "membership"
  | "rate_limit"
  | "closed"
  | "conflict"
  | "invalid"

export class SupportError extends Error {
  constructor(
    readonly code: SupportErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "SupportError"
  }
}

const CustomerTicketColumns = {
  id: SupportTicketTable.id,
  requester_email: SupportTicketTable.requester_email,
  workspace_id: SupportTicketTable.workspace_id,
  subject: SupportTicketTable.subject,
  category: SupportTicketTable.category,
  status: SupportTicketTable.status,
  priority: SupportTicketTable.priority,
  lock_version: SupportTicketTable.lock_version,
  last_message_at: SupportTicketTable.last_message_at,
  time_resolved: SupportTicketTable.time_resolved,
  time_closed: SupportTicketTable.time_closed,
  time_created: SupportTicketTable.time_created,
  time_updated: SupportTicketTable.time_updated,
} as const

export function redactSupportSecrets(value: string) {
  return value
    .replace(/(\bbearer\s+)(["']?)[A-Za-z0-9._~+\-/=]{4,}\2/gi, "$1$2[НУУЦ ХАЛХЛАВ]$2")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[НУУЦ ХАЛХЛАВ]")
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|nvapi-[A-Za-z0-9_-]{8,})\b/g,
      "[НУУЦ ХАЛХЛАВ]",
    )
    .replace(
      /(["']?\b(?:api[_-]?key|token|secret|password)\b["']?\s*[:=]\s*)(["'])([^"'\r\n]+)\2/gi,
      "$1$2[НУУЦ ХАЛХЛАВ]$2",
    )
    .replace(/\b(api[_-]?key|token|secret|password)\b(\s*[:=]\s*)([^\s,;&]+)/gi, "$1$2[НУУЦ ХАЛХЛАВ]")
}

export async function createSupportTicket(input: SupportTicketInput) {
  return Database.transaction((db) => createSupportTicketWithDb(db, input))
}

export async function createSupportTicketWithDb(db: Database.TxOrDb, raw: SupportTicketInput) {
  const input = parse(SupportTicketInputSchema, raw)
  const subject = redacted(input.subject, "Гарчиг")
  const body = redacted(input.message, "Зурвас")
  const now = new Date()
  return db.transaction(async (tx) => {
    await requireActiveAccount(tx, input.accountID)
    if (input.workspaceID) await requireMembership(tx, input.accountID, input.workspaceID)
    const open = await tx
      .select({ value: count() })
      .from(SupportTicketTable)
      .where(
        and(
          eq(SupportTicketTable.account_id, input.accountID),
          isNull(SupportTicketTable.time_deleted),
          notInArray(SupportTicketTable.status, ["resolved", "closed"]),
        ),
      )
    if ((open[0]?.value ?? 0) >= 10)
      throw new SupportError("rate_limit", "Нээлттэй хүсэлтийн дээд хязгаарт хүрсэн байна.")
    const recent = await tx
      .select({ value: count() })
      .from(SupportTicketTable)
      .where(
        and(
          eq(SupportTicketTable.account_id, input.accountID),
          gte(SupportTicketTable.time_created, new Date(now.getTime() - 86_400_000)),
        ),
      )
    if ((recent[0]?.value ?? 0) >= 20)
      throw new SupportError("rate_limit", "24 цагийн хүсэлтийн хязгаарт хүрсэн байна.")
    const ticket = {
      id: `spt_${ulid()}`,
      account_id: input.accountID,
      requester_email: input.requesterEmail,
      workspace_id: input.workspaceID,
      subject,
      category: input.category,
      status: "open" as const,
      priority: "normal" as const,
      lock_version: 0,
      last_message_at: now,
      time_created: now,
      time_updated: now,
    }
    await tx.insert(SupportTicketTable).values(ticket)
    await tx
      .insert(SupportMessageTable)
      .values({
        id: `spm_${ulid()}`,
        ticket_id: ticket.id,
        author_type: "customer",
        account_id: input.accountID,
        body,
        internal: false,
        time_created: now,
      })
    return SupportTicketResultSchema.parse({ id: ticket.id, status: ticket.status, lockVersion: 0 })
  })
}

export async function listAccountSupportTickets(input: { accountID: string; cursor?: string; limit?: 25 | 50 }) {
  return Database.use((db) => listAccountSupportTicketsWithDb(db, input))
}

export async function listAccountSupportTicketsWithDb(
  db: Database.TxOrDb,
  raw: { accountID: string; cursor?: string; limit?: 25 | 50 },
) {
  const input = parse(
    z
      .object({
        accountID: z.string().trim().min(1).max(30),
        cursor: z.string().max(80).optional(),
        limit: z.union([z.literal(25), z.literal(50)]).default(25),
      })
      .strict(),
    raw,
  )
  const cursor = input.cursor ? parseCursor(input.cursor) : undefined
  const condition = cursor
    ? and(
        eq(SupportTicketTable.account_id, input.accountID),
        isNull(SupportTicketTable.time_deleted),
        or(
          lt(SupportTicketTable.last_message_at, cursor.time),
          and(eq(SupportTicketTable.last_message_at, cursor.time), lt(SupportTicketTable.id, cursor.id)),
        ),
      )
    : and(eq(SupportTicketTable.account_id, input.accountID), isNull(SupportTicketTable.time_deleted))
  const rows = await db
    .select(CustomerTicketColumns)
    .from(SupportTicketTable)
    .where(condition)
    .orderBy(desc(SupportTicketTable.last_message_at), desc(SupportTicketTable.id))
    .limit(input.limit)
  return {
    items: rows,
    nextCursor:
      rows.length === input.limit ? `${rows.at(-1)?.last_message_at.getTime()}:${rows.at(-1)?.id}` : undefined,
  }
}

export async function getAccountSupportTicket(input: { accountID: string; ticketID: string }) {
  return Database.use((db) => getAccountSupportTicketWithDb(db, input))
}

export async function getAccountSupportTicketWithDb(db: Database.TxOrDb, raw: { accountID: string; ticketID: string }) {
  const input = parse(z.object({ accountID: z.string().trim().min(1).max(30), ticketID: TicketIDSchema }).strict(), raw)
  const ticket = await db
    .select(CustomerTicketColumns)
    .from(SupportTicketTable)
    .where(
      and(
        eq(SupportTicketTable.id, input.ticketID),
        eq(SupportTicketTable.account_id, input.accountID),
        isNull(SupportTicketTable.time_deleted),
      ),
    )
    .limit(1)
    .then((rows) => rows[0])
  if (!ticket) throw new SupportError("not_found", "Тусламжийн хүсэлт олдсонгүй.")
  const messages = await db
    .select({
      id: SupportMessageTable.id,
      author_type: SupportMessageTable.author_type,
      body: SupportMessageTable.body,
      time_created: SupportMessageTable.time_created,
    })
    .from(SupportMessageTable)
    .where(and(eq(SupportMessageTable.ticket_id, ticket.id), eq(SupportMessageTable.internal, false)))
    .orderBy(asc(SupportMessageTable.time_created), asc(SupportMessageTable.id))
    .limit(200)
  return { ticket, messages }
}

export async function replyToSupportTicket(input: SupportReplyInput) {
  return Database.transaction((db) => replyToSupportTicketWithDb(db, input))
}

export async function replyToSupportTicketWithDb(db: Database.TxOrDb, raw: SupportReplyInput) {
  const input = parse(SupportReplyInputSchema, raw)
  const body = redacted(input.message, "Зурвас")
  const now = new Date()
  return db.transaction(async (tx) => {
    await requireActiveAccount(tx, input.accountID)
    const ticket = await tx
      .select()
      .from(SupportTicketTable)
      .where(
        and(
          eq(SupportTicketTable.id, input.ticketID),
          eq(SupportTicketTable.account_id, input.accountID),
          isNull(SupportTicketTable.time_deleted),
        ),
      )
      .limit(1)
      .then((rows) => rows[0])
    if (!ticket) throw new SupportError("not_found", "Тусламжийн хүсэлт олдсонгүй.")
    if (ticket.status === "resolved" || ticket.status === "closed")
      throw new SupportError("closed", "Хаагдсан хүсэлтэд хариу нэмэх боломжгүй.")
    if (ticket.lock_version !== input.expectedLockVersion)
      throw new SupportError("conflict", "Хүсэлт өөрчлөгдсөн байна. Дахин ачаална уу.")
    const recent = await tx
      .select({ value: count() })
      .from(SupportMessageTable)
      .where(
        and(
          eq(SupportMessageTable.account_id, input.accountID),
          gte(SupportMessageTable.time_created, new Date(now.getTime() - 86_400_000)),
        ),
      )
    if ((recent[0]?.value ?? 0) >= 50) throw new SupportError("rate_limit", "24 цагийн хариуны хязгаарт хүрсэн байна.")
    const total = await tx
      .select({ value: count() })
      .from(SupportMessageTable)
      .where(eq(SupportMessageTable.ticket_id, ticket.id))
    if ((total[0]?.value ?? 0) >= 200)
      throw new SupportError("rate_limit", "Энэ хүсэлтийн зурвасын дээд хязгаарт хүрсэн байна.")
    const updated = await tx
      .update(SupportTicketTable)
      .set({
        status: "pending_support",
        last_message_at: now,
        lock_version: ticket.lock_version + 1,
        time_updated: now,
      })
      .where(
        and(
          eq(SupportTicketTable.id, ticket.id),
          eq(SupportTicketTable.lock_version, input.expectedLockVersion),
          isNull(SupportTicketTable.time_deleted),
        ),
      )
      .returning({ lock_version: SupportTicketTable.lock_version })
    if (updated.length !== 1) throw new SupportError("conflict", "Хүсэлт өөрчлөгдсөн байна. Дахин ачаална уу.")
    await tx
      .insert(SupportMessageTable)
      .values({
        id: `spm_${ulid()}`,
        ticket_id: ticket.id,
        author_type: "customer",
        account_id: input.accountID,
        body,
        internal: false,
        time_created: now,
      })
    return SupportTicketResultSchema.parse({
      id: ticket.id,
      status: "pending_support",
      lockVersion: updated[0].lock_version,
    })
  })
}

async function requireActiveAccount(db: Database.TxOrDb, accountID: string) {
  const account = await db
    .select({ status: AccountTable.status })
    .from(AccountTable)
    .where(and(eq(AccountTable.id, accountID), isNull(AccountTable.timeDeleted)))
    .limit(1)
    .then((rows) => rows[0])
  if (!account) throw new SupportError("not_found", "Бүртгэл олдсонгүй.")
  if (account.status === "suspended") throw new SupportError("suspended", "Таны бүртгэл түр түдгэлзсэн байна.")
}

async function requireMembership(db: Database.TxOrDb, accountID: string, workspaceID: string) {
  const member = await db
    .select({ id: UserTable.id })
    .from(UserTable)
    .where(
      and(eq(UserTable.accountID, accountID), eq(UserTable.workspaceID, workspaceID), isNull(UserTable.timeDeleted)),
    )
    .limit(1)
    .then((rows) => rows[0])
  if (!member) throw new SupportError("membership", "Та энэ ажлын орон зайд хандах эрхгүй байна.")
}

function redacted(value: string, field: string) {
  const result = redactSupportSecrets(value).trim()
  if (!result || result === "[НУУЦ ХАЛХЛАВ]")
    throw new SupportError("invalid", `${field} зөвхөн нууц мэдээлэл агуулж байна.`)
  return result
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (result.success) return result.data
  throw new SupportError("invalid", "Оруулсан мэдээлэл буруу байна.")
}

function parseCursor(value: string) {
  const match = /^(\d+):(spt_[0-9A-HJKMNP-TV-Z]{26})$/.exec(value)
  if (!match) throw new SupportError("invalid", "Хуудслын зааг буруу байна.")
  const timestamp = Number(match[1])
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new SupportError("invalid", "Хуудслын зааг буруу байна.")
  return { time: new Date(timestamp), id: match[2] }
}
