import { Resource } from "@mongolgpt/console-resource"
import { and, Database, eq } from "../src/drizzle/index.js"
import { ProviderCredentials } from "../src/provider-credentials.js"
import { ProviderTable } from "../src/schema/provider.sql.js"

const apply = process.argv.includes("--apply")
const allowProduction = process.argv.includes("--allow-production")

if (Resource.App.stage === "production" && apply && !allowProduction) {
  throw new Error("Production backfill apply requires --allow-production")
}

const providers = await Database.use((tx) =>
  tx
    .select({
      id: ProviderTable.id,
      workspaceID: ProviderTable.workspaceID,
      provider: ProviderTable.provider,
      credentials: ProviderTable.credentials,
    })
    .from(ProviderTable),
)
const malformed = providers.filter(
  (provider) =>
    ProviderCredentials.encrypted(provider.credentials) && !ProviderCredentials.supported(provider.credentials),
)
if (malformed.length) {
  throw new Error(`Found ${malformed.length} provider credential rows with an unsupported envelope`)
}

const plaintext = providers.filter((provider) => !ProviderCredentials.encrypted(provider.credentials))
if (!apply) {
  console.log(
    JSON.stringify({
      stage: Resource.App.stage,
      mode: "dry-run",
      total: providers.length,
      plaintext: plaintext.length,
      encrypted: providers.length - plaintext.length,
    }),
  )
  process.exit(0)
}

const encrypted = await Promise.all(
  plaintext.map(async (provider) => ({
    ...provider,
    encrypted: await ProviderCredentials.encrypt(provider),
  })),
)
const attempts = await Database.transaction(async (tx) =>
  Promise.all(
    encrypted.map((provider) =>
      tx
        .update(ProviderTable)
        .set({ credentials: provider.encrypted })
        .where(and(eq(ProviderTable.id, provider.id), eq(ProviderTable.credentials, provider.credentials))),
    ),
  ),
)
const remaining = await Database.use((tx) =>
  tx
    .select({
      credentials: ProviderTable.credentials,
    })
    .from(ProviderTable),
)
const plaintextRemaining = remaining.filter((provider) => !ProviderCredentials.encrypted(provider.credentials)).length

console.log(
  JSON.stringify({
    stage: Resource.App.stage,
    mode: "apply",
    matched: plaintext.length,
    attempted: attempts.length,
    plaintextRemaining,
  }),
)
if (plaintextRemaining) throw new Error(`Provider credential backfill incomplete: ${plaintextRemaining} rows remain`)
