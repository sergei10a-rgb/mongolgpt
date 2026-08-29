import { z } from "zod"
import { fn } from "./util/fn"
import { Actor } from "./actor"
import { and, Database, eq, isNull } from "./drizzle"
import { Identifier } from "./identifier"
import { ProviderCredentials } from "./provider-credentials"
import { ProviderTable } from "./schema/provider.sql"

const hostedByokProviders = ["openai", "anthropic", "google", "openrouter", "nvidia-nim"] as const
const maxProviderCredentialLength = 16 * 1024
const hostedByokProviderSet = new Set<string>(hostedByokProviders)

const ProviderID = z
  .string()
  .trim()
  .min(1, "Нийлүүлэгч шаардлагатай")
  .refine((value) => hostedByokProviderSet.has(value), {
    message: "OpenAI, Anthropic, Google, OpenRouter эсвэл NVIDIA NIM нийлүүлэгч сонгоно уу.",
  })

const ProviderCredentialsInput = z
  .string()
  .trim()
  .min(1, "API түлхүүр шаардлагатай")
  .max(maxProviderCredentialLength, `API түлхүүр ${maxProviderCredentialLength} тэмдэгтээс урт байж болохгүй.`)

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
    z
      .object({
        provider: ProviderID,
        credentials: ProviderCredentialsInput,
      })
      .strict(),
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
    z
      .object({
        provider: ProviderID,
      })
      .strict(),
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
