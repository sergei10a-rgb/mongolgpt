import { z } from "zod"
import { AccountAccess } from "@mongolgpt/console-core/account-access.js"
import {
  and,
  count,
  countDistinct,
  Database,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  max,
  min,
  sql,
} from "@mongolgpt/console-core/drizzle/index.js"
import { AccountTable } from "@mongolgpt/console-core/schema/account.sql.js"
import { AuthTable } from "@mongolgpt/console-core/schema/auth.sql.js"
import { UserTable } from "@mongolgpt/console-core/schema/user.sql.js"
import type { PlatformAdminContext } from "./admin-context"
import {
  AdminAuthorizationError,
  requirePlatformAdminPermission,
  writeAdminAudit,
  writeAdminAuditWithDb,
} from "./admin-auth"
import { AdminMutationRequestError, requireSameOriginAdminMutation } from "./admin-mutation"

const accountID = z.string().regex(/^acc_[0-9A-HJKMNP-TV-Z]{26}$/)

export const AdminUserDirectoryInput = z.object({
  q: z.string().trim().max(100).default(""),
  status: z.enum(["all", "active", "suspended"]).default("all"),
  cursor: accountID.optional(),
  limit: z.union([z.literal(25), z.literal(50)]).default(25),
})

export const AdminAccountStatusInput = z.object({
  accountID,
  operation: z.enum(["suspend", "reactivate"]),
  reason: AccountAccess.Reason,
})

export async function listAdminUsers(context: PlatformAdminContext, raw: unknown) {
  const admin = requirePlatformAdminPermission(context, "users.read")
  const input = AdminUserDirectoryInput.parse(raw)
  const pattern = input.q ? `%${escapeLike(input.q.toLowerCase())}%` : undefined

  return Database.use(async (tx) => {
    const fetched = await tx
      .select({
        id: AccountTable.id,
        email: min(AuthTable.subject),
        status: AccountTable.status,
        reason: AccountTable.suspension_reason,
        timeCreated: AccountTable.timeCreated,
        timeSuspended: AccountTable.time_suspended,
      })
      .from(AccountTable)
      .leftJoin(
        AuthTable,
        and(eq(AuthTable.accountID, AccountTable.id), eq(AuthTable.provider, "email"), isNull(AuthTable.timeDeleted)),
      )
      .where(
        and(
          isNull(AccountTable.timeDeleted),
          input.status === "all" ? undefined : eq(AccountTable.status, input.status),
          input.cursor ? lt(AccountTable.id, input.cursor) : undefined,
          pattern
            ? sql<boolean>`(
                lower(${AccountTable.id}) like ${pattern} escape '\'
                or lower(coalesce(${AuthTable.subject}, '')) like ${pattern} escape '\'
              )`
            : undefined,
        ),
      )
      .groupBy(
        AccountTable.id,
        AccountTable.status,
        AccountTable.suspension_reason,
        AccountTable.timeCreated,
        AccountTable.time_suspended,
      )
      .orderBy(desc(AccountTable.id))
      .limit(input.limit + 1)
    const accounts = fetched.slice(0, input.limit)
    const ids = accounts.map((account) => account.id)
    const usage =
      ids.length > 0
        ? await tx
            .select({
              accountID: UserTable.accountID,
              memberships: count(UserTable.id),
              workspaces: countDistinct(UserTable.workspaceID),
              lastSeen: max(UserTable.timeSeen),
            })
            .from(UserTable)
            .where(and(inArray(UserTable.accountID, ids), isNull(UserTable.timeDeleted)))
            .groupBy(UserTable.accountID)
        : []
    const byAccount = new Map(usage.flatMap((row) => (row.accountID ? [[row.accountID, row] as const] : [])))

    return {
      admin,
      filters: input,
      canSuspend: admin.permissions.includes("users.suspend"),
      accounts: accounts.map((account) => {
        const aggregate = byAccount.get(account.id)
        return {
          id: account.id,
          email: account.email,
          status: account.status,
          reason: account.reason,
          memberships: aggregate?.memberships ?? 0,
          workspaces: aggregate?.workspaces ?? 0,
          timeCreated: account.timeCreated.toISOString(),
          timeSuspended: account.timeSuspended?.toISOString() ?? null,
          lastSeen: dateISO(aggregate?.lastSeen),
        }
      }),
      nextCursor: fetched.length > input.limit ? accounts.at(-1)?.id : undefined,
    }
  })
}

export async function changeAdminAccountStatus(context: PlatformAdminContext, request: Request, raw: unknown) {
  const targetID =
    typeof raw === "object" && raw !== null && "accountID" in raw && typeof raw.accountID === "string"
      ? raw.accountID.slice(0, 30)
      : undefined
  const action =
    typeof raw === "object" && raw !== null && "operation" in raw && raw.operation === "reactivate"
      ? "account.reactivate"
      : "account.suspend"

  try {
    requireSameOriginAdminMutation(request)
    const admin = requirePlatformAdminPermission(context, "users.suspend")
    const input = AdminAccountStatusInput.parse(raw)
    return await Database.transaction(async (tx) => {
      const target = await tx
        .select({
          id: AccountTable.id,
          email: AuthTable.subject,
        })
        .from(AccountTable)
        .leftJoin(
          AuthTable,
          and(eq(AuthTable.accountID, AccountTable.id), eq(AuthTable.provider, "email"), isNull(AuthTable.timeDeleted)),
        )
        .where(and(eq(AccountTable.id, input.accountID), isNull(AccountTable.timeDeleted)))
      if (target.length === 0) throw new AdminAccountMutationError("not_found")
      if (
        input.operation === "suspend" &&
        target.some((identity) => identity.email?.trim().toLowerCase() === admin.email)
      ) {
        throw new AdminAccountMutationError("self_suspend")
      }

      const transition = await AccountAccess.transition(tx, {
        accountID: input.accountID,
        adminID: admin.id,
        status: input.operation === "suspend" ? "suspended" : "active",
        reason: input.reason,
      })
      await writeAdminAuditWithDb(tx, {
        adminID: admin.id,
        actorEmail: admin.email,
        action,
        outcome: "success",
        request,
        targetType: "account",
        targetID: input.accountID,
        metadata: {
          operation: input.operation,
          reason: input.reason,
          changed: transition.changed,
          before: transition.before,
          after: transition.after,
          auth_version: transition.authVersion,
          revoked_api_keys: transition.revokedApiKeys,
        },
      })
      return {
        ok: true as const,
        accountID: input.accountID,
        operation: input.operation,
        changed: transition.changed,
        message: transitionMessage(input.operation, transition.changed),
      }
    })
  } catch (error) {
    const failure = mutationFailure(error)
    await writeAdminAudit({
      adminID: context.id,
      actorEmail: context.email,
      action,
      outcome: failure.outcome,
      request,
      targetType: "account",
      targetID,
      metadata: {
        reason: failure.code,
      },
    })
    return {
      ok: false as const,
      accountID: targetID,
      message: failure.message,
    }
  }
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`)
}

function dateISO(value: Date | string | number | null | undefined) {
  if (value === null || value === undefined) return null
  return (value instanceof Date ? value : new Date(value)).toISOString()
}

function transitionMessage(operation: "suspend" | "reactivate", changed: boolean) {
  if (!changed) {
    return operation === "suspend" ? "Аккаунт өмнө нь түдгэлзсэн байна." : "Аккаунт аль хэдийн идэвхтэй байна."
  }
  return operation === "suspend"
    ? "Аккаунтыг түдгэлзүүлж, өмнөх нэвтрэх сесс болон API түлхүүрүүдийг хүчингүй болголоо."
    : "Аккаунтыг дахин идэвхжүүллээ. Хэрэглэгч шинээр нэвтрэх шаардлагатай."
}

function mutationFailure(error: unknown) {
  if (error instanceof AdminMutationRequestError) {
    return {
      outcome: "denied" as const,
      code: `request_${error.code}`,
      message: "Аюулгүй байдлын хүсэлтийн шалгалт амжилтгүй боллоо.",
    }
  }
  if (error instanceof AdminAuthorizationError) {
    return {
      outcome: "denied" as const,
      code: error.code,
      message: error.message,
    }
  }
  if (error instanceof z.ZodError) {
    return {
      outcome: "denied" as const,
      code: "invalid_input",
      message: "Аккаунтын ID, үйлдэл эсвэл шалтгаан буруу байна.",
    }
  }
  if (error instanceof AdminAccountMutationError) {
    return {
      outcome: "denied" as const,
      code: error.code,
      message:
        error.code === "self_suspend" ? "Өөрийн аккаунтыг түдгэлзүүлэх боломжгүй." : "Удирдах аккаунт олдсонгүй.",
    }
  }
  if (error instanceof AccountAccess.TransitionError) {
    return {
      outcome: error.code === "conflict" ? ("failure" as const) : ("denied" as const),
      code: error.code,
      message:
        error.code === "conflict"
          ? "Аккаунтын төлөв зэрэг өөрчлөгдсөн. Дахин оролдоно уу."
          : "Удирдах аккаунт олдсонгүй.",
    }
  }
  return {
    outcome: "failure" as const,
    code: "internal_error",
    message: "Аккаунтын төлөв өөрчлөх үед алдаа гарлаа.",
  }
}

class AdminAccountMutationError extends Error {
  constructor(readonly code: "not_found" | "self_suspend") {
    super(code)
    this.name = "AdminAccountMutationError"
  }
}
