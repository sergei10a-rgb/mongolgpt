import { pruneProviderAttemptsWithDb } from "@mongolgpt/console-core/provider-health.js"
import { Database } from "@mongolgpt/console-core/drizzle/index.js"

export async function pruneProviderAttemptRetention(now = Date.now()) {
  return Database.use((db) => pruneProviderAttemptsWithDb(db, now))
}

export default {
  async scheduled() {
    const result = await pruneProviderAttemptRetention()
    console.log("Нийлүүлэгчийн health telemetry retention дууслаа", result)
  },
}
