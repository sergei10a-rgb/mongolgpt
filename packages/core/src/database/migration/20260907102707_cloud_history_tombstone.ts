import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260907102707_cloud_history_tombstone",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`cloud_history_tombstone\` (
          \`aggregate_id\` text PRIMARY KEY,
          \`event_id\` text NOT NULL,
          \`seq\` integer NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`cloud_history_tombstone_event_id_idx\` ON \`cloud_history_tombstone\` (\`event_id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
