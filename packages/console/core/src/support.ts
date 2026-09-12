import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm"
import { ulid } from "ulid"
import { z } from "zod"
import { Database } from "./drizzle"
import { hasPlatformAdminPermission } from "./platform-admin"
import { AccountTable } from "./schema/account.sql"
import { PlatformAdminRoles, PlatformAdminTable } from "./schema/admin.sql"
import { SupportMessageTable, SupportTicketTable } from "./schema/support.sql"
import { UserTable } from "./schema/user.sql"
import { paymentBatchGuard, type PaymentBatchQuery } from "./payment-ledger"
import { financeRowMatches } from "./finance-ledger"

type SupportDependencies = { batch?: typeof Database.batch }
type SupportCheck = { condition: SQL; error: SupportError }

const CategorySchema = z.enum(["account", "billing", "technical", "feedback", "other"])
const TicketIDSchema = z.string().regex(/^spt_[0-9A-HJKMNP-TV-Z]{26}$/)
const AdminIDSchema = z.string().regex(/^adm_[0-9A-HJKMNP-TV-Z]{26}$/)
const StatusSchema = z.enum(["open", "pending_user", "pending_support", "resolved", "closed"])
const PrioritySchema = z.enum(["normal", "high", "urgent"])

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

export const AdminSupportQueueInputSchema = z
  .object({
    status: StatusSchema.optional(),
    priority: PrioritySchema.optional(),
    assignment: z.enum(["assigned", "unassigned", "mine"]).optional(),
    accountID: z.string().trim().min(1).max(30).optional(),
    cursor: z.string().max(80).optional(),
    limit: z.union([z.literal(25), z.literal(50)]).default(25),
  })
  .strict()

export const AdminSupportMutationInputSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("reply"),
      ticketID: TicketIDSchema,
      expectedLockVersion: z.number().int().nonnegative(),
      message: z.string().trim().min(1).max(5_000),
    })
    .strict(),
  z
    .object({
      operation: z.literal("note"),
      ticketID: TicketIDSchema,
      expectedLockVersion: z.number().int().nonnegative(),
      message: z.string().trim().min(1).max(5_000),
    })
    .strict(),
  z
    .object({
      operation: z.literal("update"),
      ticketID: TicketIDSchema,
      expectedLockVersion: z.number().int().nonnegative(),
      status: StatusSchema.optional(),
      priority: PrioritySchema.optional(),
      assignedAdminID: AdminIDSchema.nullable().optional(),
    })
    .strict()
    .refine(
      (value) => value.status !== undefined || value.priority !== undefined || value.assignedAdminID !== undefined,
      "Өөрчлөх утга шаардлагатай.",
    ),
])

export type AdminSupportMutationInput = z.input<typeof AdminSupportMutationInputSchema>

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

const AdminTicketColumns = {
  ...CustomerTicketColumns,
  account_id: SupportTicketTable.account_id,
  assigned_admin_id: SupportTicketTable.assigned_admin_id,
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

export async function createSupportTicket(raw: SupportTicketInput, dependencies: SupportDependencies = {}) {
  const input = parse(SupportTicketInputSchema, raw)
  const subject = redacted(input.subject, "Гарчиг")
  const body = redacted(input.message, "Зурвас")
  const now = new Date()
  const ticket = {
    id: `spt_${ulid()}`,
    account_id: input.accountID,
    requester_email: input.requesterEmail,
    workspace_id: input.workspaceID ?? null,
    subject,
    category: input.category,
    status: "open" as const,
    priority: "normal" as const,
    lock_version: 0,
    last_message_at: now,
    time_created: now,
    time_updated: now,
  }
  const message = {
    id: `spm_${ulid()}`,
    ticket_id: ticket.id,
    author_type: "customer" as const,
    account_id: input.accountID,
    body,
    internal: false,
    time_created: now,
  }
  await commitSupportMutation(
    dependencies,
    (tx) => {
      const open = tx
        .select({ value: count() })
        .from(SupportTicketTable)
        .where(
          and(
            eq(SupportTicketTable.account_id, input.accountID),
            isNull(SupportTicketTable.time_deleted),
            notInArray(SupportTicketTable.status, ["resolved", "closed"]),
          ),
        )
      const recent = tx
        .select({ value: count() })
        .from(SupportTicketTable)
        .where(
          and(
            eq(SupportTicketTable.account_id, input.accountID),
            gte(SupportTicketTable.time_created, new Date(now.getTime() - 86_400_000)),
          ),
        )
      return [
        ...accountChecks(tx, input.accountID),
        ...(input.workspaceID
          ? [
              {
                condition: exists(
                  tx
                    .select()
                    .from(UserTable)
                    .where(
                      and(
                        eq(UserTable.accountID, input.accountID),
                        eq(UserTable.workspaceID, input.workspaceID),
                        isNull(UserTable.timeDeleted),
                      ),
                    ),
                ),
                error: new SupportError("membership", "Та энэ ажлын орон зайд хандах эрхгүй байна."),
              },
            ]
          : []),
        {
          condition: sql`(${open}) < 10`,
          error: new SupportError("rate_limit", "Нээлттэй хүсэлтийн дээд хязгаарт хүрсэн байна."),
        },
        {
          condition: sql`(${recent}) < 20`,
          error: new SupportError("rate_limit", "24 цагийн хүсэлтийн хязгаарт хүрсэн байна."),
        },
      ]
    },
    (tx) => [tx.insert(SupportTicketTable).values(ticket), tx.insert(SupportMessageTable).values(message)],
    (tx) => exists(tx.select().from(SupportMessageTable).where(financeRowMatches(SupportMessageTable, message))),
  )
  return SupportTicketResultSchema.parse({ id: ticket.id, status: ticket.status, lockVersion: 0 })
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

export async function replyToSupportTicket(raw: SupportReplyInput, dependencies: SupportDependencies = {}) {
  const input = parse(SupportReplyInputSchema, raw)
  const body = redacted(input.message, "Зурвас")
  const now = new Date()
  const ticket = await loadSupportMutationTicket(input.ticketID, dependencies, input.accountID)
  const message = {
    id: `spm_${ulid()}`,
    ticket_id: ticket.id,
    author_type: "customer" as const,
    account_id: input.accountID,
    body,
    internal: false,
    time_created: now,
  }
  await commitSupportMutation(
    dependencies,
    (tx) => {
      const recent = tx
        .select({ value: count() })
        .from(SupportMessageTable)
        .where(
          and(
            eq(SupportMessageTable.account_id, input.accountID),
            gte(SupportMessageTable.time_created, new Date(now.getTime() - 86_400_000)),
          ),
        )
      return [
        ...accountChecks(tx, input.accountID),
        ...ticketChecks(tx, ticket, input.expectedLockVersion, true),
        {
          condition: sql`(${recent}) < 50`,
          error: new SupportError("rate_limit", "24 цагийн хариуны хязгаарт хүрсэн байна."),
        },
        messageLimitCheck(tx, ticket.id),
      ]
    },
    (tx) => [
      tx
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
        .returning({ lock_version: SupportTicketTable.lock_version }),
      tx.insert(SupportMessageTable).values(message),
    ],
    (tx) => exists(tx.select().from(SupportMessageTable).where(financeRowMatches(SupportMessageTable, message))),
  )
  return SupportTicketResultSchema.parse({
    id: ticket.id,
    status: "pending_support",
    lockVersion: ticket.lock_version + 1,
  })
}

export async function listAdminSupportTickets(
  input: z.input<typeof AdminSupportQueueInputSchema> & { adminID: string },
) {
  return Database.use((db) => listAdminSupportTicketsWithDb(db, input))
}

export async function listAdminSupportTicketsWithDb(
  db: Database.TxOrDb,
  raw: z.input<typeof AdminSupportQueueInputSchema> & { adminID: string },
) {
  const input = parse(AdminSupportQueueInputSchema.extend({ adminID: AdminIDSchema }), raw)
  const cursor = input.cursor ? parseCursor(input.cursor) : undefined
  const rows = await db
    .select(AdminTicketColumns)
    .from(SupportTicketTable)
    .where(
      and(
        isNull(SupportTicketTable.time_deleted),
        input.status ? eq(SupportTicketTable.status, input.status) : undefined,
        input.priority ? eq(SupportTicketTable.priority, input.priority) : undefined,
        input.accountID ? eq(SupportTicketTable.account_id, input.accountID) : undefined,
        input.assignment === "assigned" ? isNotNull(SupportTicketTable.assigned_admin_id) : undefined,
        input.assignment === "unassigned" ? isNull(SupportTicketTable.assigned_admin_id) : undefined,
        input.assignment === "mine" ? eq(SupportTicketTable.assigned_admin_id, input.adminID) : undefined,
        cursor
          ? or(
              lt(SupportTicketTable.last_message_at, cursor.time),
              and(eq(SupportTicketTable.last_message_at, cursor.time), lt(SupportTicketTable.id, cursor.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(SupportTicketTable.last_message_at), desc(SupportTicketTable.id))
    .limit(input.limit + 1)
  const items = rows.slice(0, input.limit)
  return {
    items,
    nextCursor:
      rows.length > input.limit ? `${items.at(-1)?.last_message_at.getTime()}:${items.at(-1)?.id}` : undefined,
  }
}

export async function getAdminSupportTicket(input: { ticketID: string }) {
  return Database.use((db) => getAdminSupportTicketWithDb(db, input))
}

export async function getAdminSupportTicketWithDb(db: Database.TxOrDb, raw: { ticketID: string }) {
  const input = parse(z.object({ ticketID: TicketIDSchema }).strict(), raw)
  const ticket = await db
    .select(AdminTicketColumns)
    .from(SupportTicketTable)
    .where(and(eq(SupportTicketTable.id, input.ticketID), isNull(SupportTicketTable.time_deleted)))
    .limit(1)
    .then((rows) => rows[0])
  if (!ticket) throw new SupportError("not_found", "Тусламжийн хүсэлт олдсонгүй.")
  const messages = await db
    .select({
      id: SupportMessageTable.id,
      author_type: SupportMessageTable.author_type,
      account_id: SupportMessageTable.account_id,
      admin_id: SupportMessageTable.admin_id,
      body: SupportMessageTable.body,
      internal: SupportMessageTable.internal,
      time_created: SupportMessageTable.time_created,
    })
    .from(SupportMessageTable)
    .where(eq(SupportMessageTable.ticket_id, ticket.id))
    .orderBy(asc(SupportMessageTable.time_created), asc(SupportMessageTable.id))
    .limit(200)
  return { ticket, messages }
}

export type AdminSupportMutationResult = {
  id: string
  status: typeof SupportTicketTable.$inferSelect.status
  priority: typeof SupportTicketTable.$inferSelect.priority
  assignedAdminID: string | null
  lockVersion: number
}

export async function mutateAdminSupportTicket(
  raw: AdminSupportMutationInput & { adminID: string },
  dependencies: SupportDependencies & {
    effect?: (
      db: Database.TxOrDb,
      context: { before: typeof SupportTicketTable.$inferSelect; after: AdminSupportMutationResult },
    ) => readonly PaymentBatchQuery[]
  } = {},
) {
  const { adminID, ...mutation } = raw
  const input = {
    ...parse(AdminSupportMutationInputSchema, mutation),
    ...parse(z.object({ adminID: AdminIDSchema }).strict(), { adminID }),
  }
  const now = new Date()
  const ticket = await loadSupportMutationTicket(input.ticketID, dependencies)
  const message =
    input.operation === "update"
      ? undefined
      : {
          id: `spm_${ulid()}`,
          ticket_id: ticket.id,
          author_type: "admin" as const,
          admin_id: input.adminID,
          body: redacted(input.message, "Зурвас"),
          internal: input.operation === "note",
          time_created: now,
        }

  let status = ticket.status
  let priority = ticket.priority
  let assignedAdminID = ticket.assigned_admin_id
  let timeResolved = ticket.time_resolved
  let timeClosed = ticket.time_closed
  let customerVisibleActivity = false
  if (input.operation === "reply") {
    if (ticket.status === "resolved" || ticket.status === "closed")
      throw new SupportError("closed", "Хаагдсан хүсэлтэд хариу нэмэх боломжгүй.")
    status = "pending_user"
    customerVisibleActivity = true
  } else if (input.operation === "update") {
    priority = input.priority ?? priority
    assignedAdminID = input.assignedAdminID === undefined ? assignedAdminID : input.assignedAdminID
    if (input.status !== undefined && input.status !== ticket.status) {
      const next = input.status
      if (!canTransitionSupportStatus(ticket.status, next))
        throw new SupportError("invalid", "Хүсэлтийн төлөвийг энэ дарааллаар өөрчлөх боломжгүй.")
      status = next
      if (next === "resolved") {
        timeResolved = now
        timeClosed = null
      } else if (next === "closed") {
        timeResolved = ticket.time_resolved
        timeClosed = now
      }
    }
  }

  const result: AdminSupportMutationResult = {
    id: ticket.id,
    status,
    priority,
    assignedAdminID,
    lockVersion: ticket.lock_version + 1,
  }
  await commitSupportMutation(
    dependencies,
    (tx) => [
      {
        condition: activeSupportAdmin(tx, input.adminID),
        error: new SupportError("forbidden", "Тусламжийн хүсэлт өөрчлөх эрх хүрэлцэхгүй байна."),
      },
      ...ticketChecks(tx, ticket, input.expectedLockVersion, input.operation === "reply"),
      ...(input.operation === "update" && input.assignedAdminID
        ? [
            {
              condition: activeSupportAdmin(tx, input.assignedAdminID),
              error: new SupportError("invalid", "Оноох админ тусламжийн хүсэлт хариуцах эрхгүй байна."),
            },
          ]
        : []),
      ...(message ? [messageLimitCheck(tx, ticket.id)] : []),
    ],
    (tx) => [
      tx
        .update(SupportTicketTable)
        .set({
          status,
          priority,
          assigned_admin_id: assignedAdminID,
          lock_version: ticket.lock_version + 1,
          last_message_at: customerVisibleActivity ? now : ticket.last_message_at,
          time_resolved: timeResolved,
          time_closed: timeClosed,
          time_updated: now,
        })
        .where(
          and(
            eq(SupportTicketTable.id, ticket.id),
            eq(SupportTicketTable.lock_version, input.expectedLockVersion),
            isNull(SupportTicketTable.time_deleted),
          ),
        )
        .returning({ lockVersion: SupportTicketTable.lock_version }),
      ...(message ? [tx.insert(SupportMessageTable).values(message)] : []),
      ...(dependencies.effect?.(tx, { before: ticket, after: result }) ?? []),
    ],
    message
      ? (tx) => exists(tx.select().from(SupportMessageTable).where(financeRowMatches(SupportMessageTable, message)))
      : undefined,
  )
  return result
}

function canTransitionSupportStatus(from: z.output<typeof StatusSchema>, to: z.output<typeof StatusSchema>) {
  if (from === "open") return to === "pending_user" || to === "pending_support" || to === "resolved"
  if (from === "pending_user") return to === "pending_support" || to === "resolved"
  if (from === "pending_support") return to === "pending_user" || to === "resolved"
  return from === "resolved" && to === "closed"
}

function activeSupportAdmin(db: Database.TxOrDb, adminID: string) {
  return exists(
    db
      .select()
      .from(PlatformAdminTable)
      .where(
        and(
          eq(PlatformAdminTable.id, adminID),
          eq(PlatformAdminTable.status, "active"),
          isNull(PlatformAdminTable.timeDeleted),
          inArray(
            PlatformAdminTable.role,
            PlatformAdminRoles.filter((role) => hasPlatformAdminPermission(role, "support.manage")),
          ),
        ),
      )
      .limit(1),
  )
}

function accountChecks(db: Database.TxOrDb, accountID: string): SupportCheck[] {
  const scope = and(eq(AccountTable.id, accountID), isNull(AccountTable.timeDeleted))
  return [
    {
      condition: exists(db.select().from(AccountTable).where(scope)),
      error: new SupportError("not_found", "Бүртгэл олдсонгүй."),
    },
    {
      condition: exists(
        db
          .select()
          .from(AccountTable)
          .where(and(scope, eq(AccountTable.status, "active"))),
      ),
      error: new SupportError("suspended", "Таны бүртгэл түр түдгэлзсэн байна."),
    },
  ]
}

async function loadSupportMutationTicket(ticketID: string, dependencies: SupportDependencies, accountID?: string) {
  const [rows] = await (dependencies.batch ?? Database.batch)((db) => [
    db
      .select()
      .from(SupportTicketTable)
      .where(
        and(
          eq(SupportTicketTable.id, ticketID),
          isNull(SupportTicketTable.time_deleted),
          accountID ? eq(SupportTicketTable.account_id, accountID) : undefined,
        ),
      )
      .limit(1),
  ])
  if (!rows[0]) throw new SupportError("not_found", "Тусламжийн хүсэлт олдсонгүй.")
  return rows[0]
}

function ticketChecks(
  db: Database.TxOrDb,
  ticket: typeof SupportTicketTable.$inferSelect,
  version: number,
  replying: boolean,
): SupportCheck[] {
  const scope = and(
    eq(SupportTicketTable.id, ticket.id),
    eq(SupportTicketTable.account_id, ticket.account_id),
    isNull(SupportTicketTable.time_deleted),
  )
  return [
    {
      condition: exists(db.select().from(SupportTicketTable).where(scope)),
      error: new SupportError("not_found", "Тусламжийн хүсэлт олдсонгүй."),
    },
    ...(replying
      ? [
          {
            condition: exists(
              db
                .select()
                .from(SupportTicketTable)
                .where(and(scope, notInArray(SupportTicketTable.status, ["resolved", "closed"]))),
            ),
            error: new SupportError("closed", "Хаагдсан хүсэлтэд хариу нэмэх боломжгүй."),
          },
        ]
      : []),
    {
      condition: exists(
        db
          .select()
          .from(SupportTicketTable)
          .where(and(financeRowMatches(SupportTicketTable, ticket), eq(SupportTicketTable.lock_version, version))),
      ),
      error: new SupportError("conflict", "Хүсэлт өөрчлөгдсөн байна. Дахин ачаална уу."),
    },
  ]
}

function messageLimitCheck(db: Database.TxOrDb, ticketID: string): SupportCheck {
  const total = db
    .select({ value: count() })
    .from(SupportMessageTable)
    .where(eq(SupportMessageTable.ticket_id, ticketID))
  return {
    condition: sql`(${total}) < 200`,
    error: new SupportError("rate_limit", "Энэ хүсэлтийн зурвасын дээд хязгаарт хүрсэн байна."),
  }
}

async function commitSupportMutation(
  dependencies: SupportDependencies,
  checks: (db: Database.TxOrDb) => SupportCheck[],
  queries: (db: Database.TxOrDb) => readonly PaymentBatchQuery[],
  committed?: (db: Database.TxOrDb) => SQL,
) {
  const batch = dependencies.batch ?? Database.batch
  try {
    await batch((db) => [paymentBatchGuard(db, and(...checks(db).map((check) => check.condition))), ...queries(db)])
  } catch (error) {
    // Read only after failure: never repeat a mutation or an audit on an uncertain acknowledgement.
    const conditions: SupportCheck[] = []
    const [rows] = await batch((db) => {
      conditions.push(...checks(db))
      return [
        db
          .select({
            committed: sql<number>`CASE WHEN ${committed?.(db) ?? sql`0`} THEN 1 ELSE 0 END`,
            failure: sql<number>`CASE ${sql.join(
              conditions.map((check, index) => sql`WHEN NOT (${check.condition}) THEN ${index}`),
              sql` `,
            )} ELSE -1 END`,
          })
          .from(sql`(select 1)`),
      ]
    })
    if (rows[0]?.committed === 1) return
    const failure = rows[0]?.failure ?? -1
    if (failure >= 0) throw conditions[failure].error
    throw error
  }
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
