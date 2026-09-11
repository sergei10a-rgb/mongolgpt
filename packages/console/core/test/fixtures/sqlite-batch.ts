import type { Database } from "../../src/drizzle"

export function sqliteBatch(transaction: <T>(callback: (db: Database.TxOrDb) => Promise<T>) => Promise<T>) {
  // This adapter preserves rollback; the workerd suite separately verifies real D1 behavior.
  return ((callback: (db: Database.TxOrDb) => readonly PromiseLike<unknown>[]) =>
    transaction(async (db) => {
      const results = []
      for (const query of callback(db)) {
        if (!("_prepare" in query)) throw new Error("Expected a deferred Drizzle query")
        results.push(await query)
      }
      return results
    })) as typeof Database.batch
}
