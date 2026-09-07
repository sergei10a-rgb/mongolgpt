export * as CloudCheckpoint from "./cloud-checkpoint"

import { Schema } from "effect"

const Identifier = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.:-]{1,256}$/))
const Sequence = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThan(Number.MAX_SAFE_INTEGER))
const Bytes = Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(16 * 1024 ** 3 + 128))
const Hash = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
const UUID = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
)

export const Inventory = Schema.Struct({
  version: Schema.Literal(1),
  database: Schema.Struct({ bytes: Bytes, sha256: Hash, schemaSha256: Hash }),
  projects: Schema.Array(Schema.Struct({ id: Identifier, journaled: Schema.Boolean })),
  sessions: Schema.Array(Schema.Struct({ id: Identifier, projectID: Identifier, journaled: Schema.Boolean })),
  aggregates: Schema.Array(Schema.Struct({ id: Identifier, seq: Sequence, events: Sequence, sha256: Hash })),
  eventIDs: Schema.Array(Schema.Struct({ id: Identifier, aggregateID: Identifier, seq: Sequence })),
  tombstonesRecorded: Schema.Boolean,
  tombstones: Schema.Array(Schema.Struct({ aggregateID: Identifier, id: Identifier, seq: Sequence })),
  counts: Schema.Struct({ events: Sequence, tombstones: Sequence }),
})
export type Inventory = typeof Inventory.Type

export const Archive = Schema.Struct({
  backupID: UUID,
  keyID: Identifier,
  bytes: Bytes,
  sha256: Hash,
  plaintext: Schema.Struct({ bytes: Bytes, sha256: Hash }),
})
export type Archive = typeof Archive.Type

export const Checkpoint = Schema.Struct({ id: UUID, inventory: Inventory, sqlite: Archive, files: Archive })
export type Checkpoint = typeof Checkpoint.Type

export const FileRevision = Schema.Struct({
  id: UUID,
  checkpointID: UUID,
  sequence: Sequence.check(Schema.isGreaterThan(0)),
  previousID: Schema.NullOr(UUID),
  archive: Archive,
})
export interface FileRevision extends Schema.Schema.Type<typeof FileRevision> {}
