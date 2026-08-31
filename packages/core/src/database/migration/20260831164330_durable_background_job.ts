import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260831164330_durable_background_job",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`background_job\` (
          \`namespace\` text NOT NULL,
          \`id\` text NOT NULL,
          \`type\` text NOT NULL,
          \`title\` text,
          \`status\` text NOT NULL,
          \`started_at\` integer NOT NULL,
          \`completed_at\` integer,
          \`output\` text,
          \`error\` text,
          \`metadata\` text,
          \`owner_token\` text NOT NULL,
          \`generation\` integer NOT NULL,
          \`heartbeat_at\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`background_job_pk\` PRIMARY KEY(\`namespace\`, \`id\`)
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`background_job_namespace_status_heartbeat_idx\` ON \`background_job\` (\`namespace\`,\`status\`,\`heartbeat_at\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
