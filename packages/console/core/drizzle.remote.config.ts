import { Resource } from "sst"
import { defineConfig } from "drizzle-kit"

const database = Resource.Database as unknown as { databaseId: string }

export default defineConfig({
  out: "./migrations-d1/",
  strict: true,
  schema: ["./src/schema-d1/index.ts"],
  verbose: true,
  dialect: "sqlite",
  driver: "d1-http",
  dbCredentials: {
    accountId: process.env.CLOUDFLARE_DEFAULT_ACCOUNT_ID!,
    databaseId: database.databaseId,
    token: process.env.CLOUDFLARE_API_TOKEN!,
  },
})
