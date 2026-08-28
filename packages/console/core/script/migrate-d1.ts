import { Resource } from "sst"
import { migrateD1 } from "../src/d1-http-migrator"

const result = await migrateD1({
  accountId: requireEnvironment("CLOUDFLARE_DEFAULT_ACCOUNT_ID"),
  databaseId: requireDatabaseId(Resource.Database),
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
  return value.databaseId
}
