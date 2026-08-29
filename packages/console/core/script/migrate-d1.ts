import { Resource } from "sst"
import { migrateD1 } from "../src/d1-http-migrator"

const result = await migrateD1({
  accountId: requireEnvironment("CLOUDFLARE_DEFAULT_ACCOUNT_ID"),
  databaseId: resolveDatabaseId(),
  apiToken: requireEnvironment("CLOUDFLARE_API_TOKEN"),
  onApplied: (name) => console.log(`D1 migration хэрэглэв: ${name}`),
})

console.log(`D1 migration дууслаа: ${result.applied} шинэ, нийт ${result.total}.`)

function requireEnvironment(name: string) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} дутуу байна.`)
  return value
}

function requireDatabaseId(value: unknown) {
  if (!value || typeof value !== "object" || !("databaseId" in value) || typeof value.databaseId !== "string") {
    throw new Error("SST Database resource буруу байна.")
  }
  const databaseId = value.databaseId.trim()
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(databaseId)) {
    throw new Error("D1 Database UUID буруу байна.")
  }
  return databaseId
}

function resolveDatabaseId() {
  const databaseId = process.env.MONGOLGPT_DATABASE_ID?.trim()
  if (databaseId) return requireDatabaseId({ databaseId })
  return requireDatabaseId(Resource.Database)
}
