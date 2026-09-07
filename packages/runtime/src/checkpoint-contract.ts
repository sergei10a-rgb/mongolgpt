import { Schema } from "effect"
import { CloudCheckpoint } from "@mongolgpt/schema/cloud-checkpoint"
import { HistoryError } from "./history"

/** Decode and copy before any await; caller-owned objects cannot change a publication. */
export function decodeCheckpoint(input: unknown): CloudCheckpoint.Checkpoint {
  try {
    const json = JSON.stringify(input)
    if (typeof json !== "string" || new TextEncoder().encode(json).byteLength > 1024 * 1024) throw invalid()
    const value = Schema.decodeUnknownSync(CloudCheckpoint.Checkpoint)(
      Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(json),
      { onExcessProperty: "error" },
    )
    const inventory = value.inventory
    const projects = unique(inventory.projects, (row) => row.id)
    const sessions = unique(inventory.sessions, (row) => row.id)
    for (const row of sessions.values()) {
      if (!projects.has(row.projectID) || projects.has(row.id)) throw invalid()
    }
    const aggregates = unique(inventory.aggregates, (row) => row.id)
    const events = unique(inventory.eventIDs, (row) => row.id)
    const heads = new Map<string, number>()
    for (const row of inventory.eventIDs) {
      if (!aggregates.has(row.aggregateID) || row.seq !== (heads.get(row.aggregateID) ?? -1) + 1) throw invalid()
      heads.set(row.aggregateID, row.seq)
    }
    for (const row of aggregates.values()) {
      if (
        (!projects.has(row.id) && !sessions.has(row.id)) ||
        heads.get(row.id) !== row.seq ||
        row.events !== row.seq + 1
      )
        throw invalid()
    }
    for (const row of [...projects.values(), ...sessions.values()]) {
      if (row.journaled !== aggregates.has(row.id)) throw invalid()
    }
    const erased = unique(inventory.tombstones, (row) => row.aggregateID)
    unique(inventory.tombstones, (row) => row.id)
    for (const row of erased.values()) {
      if (
        projects.has(row.aggregateID) ||
        sessions.has(row.aggregateID) ||
        aggregates.has(row.aggregateID) ||
        events.has(row.id)
      )
        throw invalid()
    }
    if (
      (!inventory.tombstonesRecorded && erased.size) ||
      inventory.counts.events !== events.size ||
      inventory.counts.tombstones !== erased.size
    )
      throw invalid()
    if (
      value.sqlite.backupID === value.files.backupID ||
      value.sqlite.plaintext.bytes !== inventory.database.bytes ||
      value.sqlite.plaintext.sha256 !== inventory.database.sha256
    )
      throw invalid()
    return value
  } catch {
    throw invalid()
  }
}

function unique<T>(rows: readonly T[], key: (row: T) => string) {
  const map = new Map(rows.map((row) => [key(row), row]))
  if (map.size !== rows.length) throw invalid()
  return map
}

function invalid() {
  return new HistoryError("invalid_input")
}

export function decodeFileRevision(input: unknown): CloudCheckpoint.FileRevision {
  try {
    const json = JSON.stringify(input)
    if (typeof json !== "string" || new TextEncoder().encode(json).byteLength > 4096) throw invalid()
    const value = Schema.decodeUnknownSync(CloudCheckpoint.FileRevision)(
      Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(json),
      { onExcessProperty: "error" },
    )
    if ((value.sequence === 1) !== (value.previousID === null) || value.previousID === value.id) throw invalid()
    return value
  } catch {
    throw invalid()
  }
}
