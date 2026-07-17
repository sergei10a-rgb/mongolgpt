import { z } from "zod"
import { fn } from "./util/fn"
import { Actor } from "./actor"
import { and, Database, eq, isNull } from "./drizzle"
import { Identifier } from "./identifier"
import { ProviderCredentials } from "./provider-credentials"
import { ProviderTable } from "./schema/provider.sql"

export namespace Provider {
  export const list = fn(z.void(), () =>
    Database.use((tx) =>
      tx
        .select({
          provider: ProviderTable.provider,
        })
        .from(ProviderTable)
        .where(and(eq(ProviderTable.workspaceID, Actor.workspace()), isNull(ProviderTable.timeDeleted))),
    ),
  )

  export const create = fn(
    z.object({
      provider: z.string().min(1).max(64),
      credentials: z.string(),
    }),
    async ({ provider, credentials }) => {
      Actor.assertAdmin()
      const workspaceID = Actor.workspace()
      const encrypted = await ProviderCredentials.encrypt({
        workspaceID,
        provider,
        credentials,
      })
      return Database.use((tx) =>
        tx
          .insert(ProviderTable)
          .values({
            id: Identifier.create("provider"),
            workspaceID,
            provider,
            credentials: encrypted,
          })
          .onConflictDoUpdate({
            target: [ProviderTable.workspaceID, ProviderTable.provider],
            set: {
              credentials: encrypted,
              timeDeleted: null,
            },
          }),
      )
    },
  )

  export const remove = fn(
    z.object({
      provider: z.string(),
    }),
    async ({ provider }) => {
      Actor.assertAdmin()
      return Database.use((tx) =>
        tx
          .delete(ProviderTable)
          .where(and(eq(ProviderTable.provider, provider), eq(ProviderTable.workspaceID, Actor.workspace()))),
      )
    },
  )
}
