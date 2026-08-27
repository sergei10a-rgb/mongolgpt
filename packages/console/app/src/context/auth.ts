import { getRequestEvent } from "solid-js/web"
import { and, Database, eq, inArray, isNull } from "@mongolgpt/console-core/drizzle/index.js"
import { AccountTable } from "@mongolgpt/console-core/schema/account.sql.js"
import { UserTable } from "@mongolgpt/console-core/schema/user.sql.js"
import { redirect } from "@solidjs/router"
import { Actor } from "@mongolgpt/console-core/actor.js"

import { createClient } from "@openauthjs/openauth/client"
import { createSubjects } from "@openauthjs/openauth/subject"
import { z } from "zod"

export const AuthSubjects = createSubjects({
  account: z.object({
    accountID: z.string(),
    email: z.string(),
    newAccount: z.boolean().optional(),
    authVersion: z.number().int().nonnegative().optional(),
  }),
  user: z.object({
    userID: z.string(),
    workspaceID: z.string(),
  }),
})

export const AuthClient = createClient({
  clientID: "app",
  issuer: import.meta.env.VITE_AUTH_URL,
  subjects: AuthSubjects,
})

import { useSession } from "@solidjs/start/http"
import { Resource } from "@mongolgpt/console-resource"
import { resolveSessionAccess } from "~/lib/session-access"

export interface AuthSession {
  account?: Record<
    string,
    {
      id: string
      email: string
      authVersion?: number
    }
  >
  current?: string
  blocked?: "suspended"
}

export function useAuthSession() {
  return useSession<AuthSession>({
    password: Resource.MONGOLGPT_GATEWAY_SESSION_SECRET.value,
    name: import.meta.env.PROD ? "__Host-mongolgpt-auth" : "auth",
    maxAge: 60 * 60 * 24 * 365,
    cookie: {
      secure: import.meta.env.PROD,
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    },
  })
}

export async function validateAuthSession() {
  const auth = await useAuthSession()
  const entries = Object.entries(auth.data.account ?? {})
  if (entries.length === 0) {
    const resolved = resolveSessionAccess({
      accounts: {},
      current: auth.data.current,
      blocked: auth.data.blocked,
      records: [],
    })
    return {
      data: {
        ...auth.data,
        account: resolved.accounts,
        current: resolved.current,
        blocked: resolved.blocked,
      },
      suspended: resolved.suspended,
    }
  }

  const records = await Database.use((tx) =>
    tx
      .select({
        id: AccountTable.id,
        status: AccountTable.status,
        auth_version: AccountTable.auth_version,
        timeDeleted: AccountTable.timeDeleted,
      })
      .from(AccountTable)
      .where(
        inArray(
          AccountTable.id,
          entries.map(([id]) => id),
        ),
      ),
  )
  const resolved = resolveSessionAccess({
    accounts: auth.data.account ?? {},
    current: auth.data.current,
    blocked: auth.data.blocked,
    records,
  })
  const changed =
    entries.length !== Object.keys(resolved.accounts).length ||
    resolved.current !== auth.data.current ||
    resolved.blocked !== auth.data.blocked
  if (changed) {
    await auth.update((value) => ({
      ...value,
      account: resolved.accounts,
      current: resolved.current,
      blocked: resolved.blocked,
    }))
  }

  return {
    data: {
      ...auth.data,
      account: resolved.accounts,
      current: resolved.current,
      blocked: resolved.blocked,
    },
    suspended: resolved.suspended,
  }
}

export const getActor = async (workspace?: string): Promise<Actor.Info> => {
  "use server"
  const evt = getRequestEvent()
  if (!evt) throw new Error("RequestEvent олдсонгүй")
  if (evt.locals.actor) return evt.locals.actor
  evt.locals.actor = (async () => {
    const auth = await validateAuthSession()
    if (!workspace) {
      const account = auth.data.account ?? {}
      const current = account[auth.data.current ?? ""]
      if (current) {
        return {
          type: "account",
          properties: {
            email: current.email,
            accountID: current.id,
          },
        }
      }
      if (auth.suspended) throw redirect("/auth/suspended")
      return {
        type: "public",
        properties: {},
      }
    }
    const accounts = Object.keys(auth.data.account ?? {})
    if (accounts.length) {
      const user = await Database.use((tx) =>
        tx
          .select()
          .from(UserTable)
          .where(
            and(
              eq(UserTable.workspaceID, workspace),
              isNull(UserTable.timeDeleted),
              inArray(UserTable.accountID, accounts),
            ),
          )
          .limit(1)
          .execute()
          .then((x) => x[0]),
      )
      if (user) {
        await Database.use((tx) =>
          tx
            .update(UserTable)
            .set({ timeSeen: new Date() })
            .where(and(eq(UserTable.workspaceID, workspace), eq(UserTable.id, user.id))),
        )
        return {
          type: "user",
          properties: {
            userID: user.id,
            workspaceID: user.workspaceID,
            accountID: user.accountID,
            role: user.role,
          },
        }
      }
    }
    if (auth.suspended) throw redirect("/auth/suspended")
    throw redirect("/auth/authorize")
  })()
  return evt.locals.actor
}
