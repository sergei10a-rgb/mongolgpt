import { defineConfig } from "drizzle-kit"

export default defineConfig({
  out: "./migrations-d1/",
  strict: true,
  schema: ["./src/schema-d1/index.ts"],
  verbose: true,
  dialect: "sqlite",
})
