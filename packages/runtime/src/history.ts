export type HistoryScope = { accountID: string; workspaceID: string }
// A fresh random writer ID per process start; epoch is a fencing token, not a TTL.
export type HistoryLease = HistoryScope & { epoch: number; writerID: string }
export type HistoryEvent = {
  id: string
  aggregateID: string
  seq: number
  type: string
  data: Record<string, unknown>
}
export type HistoryEntry =
  | { cursor: number; deleted: false; event: HistoryEvent }
  | { cursor: number; deleted: true; aggregateID: string; id: string; seq: number }

const MAX_EVENT_BYTES = 1024 * 1024
const MAX_PAGE_ENTRIES = 10
const encoder = new TextEncoder()
const messages = {
  invalid_input: "Cloud түүхийн өгөгдөл буруу байна.",
  conflict: "Cloud түүхийн дараалал зөрсөн байна. Сессийг дахин ачаална уу.",
  fenced: "Cloud runtime шинэчлэгдсэн байна. Сессийг дахин ачаална уу.",
  unavailable: "Cloud түүхийг хадгалах үйлчилгээнд холбогдож чадсангүй.",
} as const

export class HistoryError extends Error {
  readonly code: keyof typeof messages

  constructor(code: keyof typeof messages) {
    super(messages[code])
    this.name = "HistoryError"
    this.code = code
  }
}

type StoredEvent = {
  cursor: number
  event_id: string
  session_id: string
  seq: number
  type: string | null
  data: string | null
  digest: string
  deleted: number
}

// This store is Worker-internal. Callers must derive scope from trusted identity,
// never from request JSON. Events must already be schema-encoded/versioned by
// EventV2. It deliberately exposes no SQL or database credential.
export function createHistoryStore(db: Pick<D1Database, "prepare" | "batch">) {
  async function batch<T>(statements: D1PreparedStatement[]) {
    try {
      const results = await db.batch<T>(statements)
      if (results.some((result) => !result.success)) throw new HistoryError("unavailable")
      return results
    } catch {
      throw new HistoryError("unavailable")
    }
  }

  function writer(scope: HistoryScope) {
    return db
      .prepare("SELECT epoch, writer_id FROM runtime_history_writer WHERE account_id = ? AND workspace_id = ?")
      .bind(scope.accountID, scope.workspaceID)
  }

  async function epoch(scope: HistoryScope) {
    validateScope(scope)
    const result = await batch<{ epoch: number }>([writer(scope)])
    return result[0].results[0]?.epoch ?? 0
  }

  async function claim(
    tenant: HistoryScope,
    claim: { expectedEpoch: number; writerID: string },
  ): Promise<HistoryLease> {
    const scope = { ...tenant }
    const input = { ...claim }
    validateScope(scope)
    integer(input.expectedEpoch)
    identifier(input.writerID)
    const next = input.expectedEpoch + 1
    integer(next)
    const result = await batch<{ epoch: number; writer_id: string }>([
      db
        .prepare(
          `INSERT INTO runtime_history_writer (account_id, workspace_id, epoch, writer_id)
        SELECT ?, ?, 1, ? WHERE ? = 0 ON CONFLICT (account_id, workspace_id) DO NOTHING`,
        )
        .bind(scope.accountID, scope.workspaceID, input.writerID, input.expectedEpoch),
      db
        .prepare(
          `UPDATE runtime_history_writer SET epoch = ?, writer_id = ?
        WHERE account_id = ? AND workspace_id = ? AND epoch = ? AND writer_id != ?`,
        )
        .bind(next, input.writerID, scope.accountID, scope.workspaceID, input.expectedEpoch, input.writerID),
      writer(scope),
    ])
    const row = result[2].results[0]
    if (row?.epoch !== next || row.writer_id !== input.writerID) throw new HistoryError("fenced")
    return { ...scope, epoch: next, writerID: input.writerID }
  }

  async function append(lease: HistoryLease, event: HistoryEvent) {
    validateEvent(event)
    return commit(lease, event, false)
  }

  async function erase(lease: HistoryLease, input: Pick<HistoryEvent, "id" | "aggregateID" | "seq">) {
    validateEventID(input)
    return commit(lease, input, true)
  }

  async function commit(
    writerLease: HistoryLease,
    input: Pick<HistoryEvent, "id" | "aggregateID" | "seq"> & Partial<Pick<HistoryEvent, "type" | "data">>,
    deleted: boolean,
  ) {
    const lease = { ...writerLease }
    const event = { ...input }
    validateScope(lease)
    integer(lease.epoch, 1)
    identifier(lease.writerID)
    const data = deleted ? null : canonical(event.data)
    if (data !== null && encoder.encode(data).byteLength > MAX_EVENT_BYTES) throw new HistoryError("invalid_input")
    const type = deleted ? null : event.type!
    const fingerprint = await digest(JSON.stringify([event.aggregateID, event.seq, type, data, deleted]))
    const scope = [lease.accountID, lease.workspaceID]
    // Preconditions, insert, head advancement and the receipt are one D1 batch.
    // A failed CAS cannot acknowledge an event or purge any previous history.
    const result = await batch<StoredEvent & { epoch: number; writer_id: string }>([
      db
        .prepare(
          `INSERT INTO runtime_history_session (account_id, workspace_id, session_id)
        SELECT account_id, workspace_id, ? FROM runtime_history_writer
        WHERE account_id = ? AND workspace_id = ? AND epoch = ? AND writer_id = ? AND ? = 0
          AND NOT EXISTS (SELECT 1 FROM runtime_history_event WHERE account_id = ? AND workspace_id = ? AND event_id = ?)
        ON CONFLICT (account_id, workspace_id, session_id) DO NOTHING`,
        )
        .bind(event.aggregateID, ...scope, lease.epoch, lease.writerID, event.seq, ...scope, event.id),
      db
        .prepare(
          `INSERT INTO runtime_history_event
        (account_id, workspace_id, session_id, event_id, seq, type, data, digest, deleted)
        SELECT s.account_id, s.workspace_id, s.session_id, ?, ?, ?, ?, ?, ?
        FROM runtime_history_session s JOIN runtime_history_writer w
          ON w.account_id = s.account_id AND w.workspace_id = s.workspace_id
        WHERE s.account_id = ? AND s.workspace_id = ? AND s.session_id = ?
          AND s.seq = ? AND s.deleted = 0 AND w.epoch = ? AND w.writer_id = ?
        ON CONFLICT DO NOTHING`,
        )
        .bind(
          event.id,
          event.seq,
          type,
          data,
          fingerprint,
          Number(deleted),
          ...scope,
          event.aggregateID,
          event.seq - 1,
          lease.epoch,
          lease.writerID,
        ),
      db
        .prepare(
          `UPDATE runtime_history_session SET seq = ?, deleted = ?
        WHERE account_id = ? AND workspace_id = ? AND session_id = ? AND seq = ? AND deleted = 0
          AND EXISTS (SELECT 1 FROM runtime_history_writer WHERE account_id = ? AND workspace_id = ?
            AND epoch = ? AND writer_id = ?)
          AND EXISTS (SELECT 1 FROM runtime_history_event WHERE account_id = ? AND workspace_id = ?
            AND event_id = ? AND digest = ?)`,
        )
        .bind(
          event.seq,
          Number(deleted),
          ...scope,
          event.aggregateID,
          event.seq - 1,
          ...scope,
          lease.epoch,
          lease.writerID,
          ...scope,
          event.id,
          fingerprint,
        ),
      // Keep a content-free terminal record in the replay feed. Offline projections
      // see the deletion too, and retries can never resurrect the erased session.
      db
        .prepare(
          `DELETE FROM runtime_history_event
        WHERE ? = 1 AND account_id = ? AND workspace_id = ? AND session_id = ? AND event_id != ?
          AND EXISTS (SELECT 1 FROM runtime_history_writer WHERE account_id = ? AND workspace_id = ?
            AND epoch = ? AND writer_id = ?)
          AND EXISTS (SELECT 1 FROM runtime_history_event terminal WHERE terminal.account_id = ?
            AND terminal.workspace_id = ? AND terminal.event_id = ? AND terminal.digest = ? AND terminal.deleted = 1)`,
        )
        .bind(
          Number(deleted),
          ...scope,
          event.aggregateID,
          event.id,
          ...scope,
          lease.epoch,
          lease.writerID,
          ...scope,
          event.id,
          fingerprint,
        ),
      db
        .prepare(
          "SELECT cursor, digest FROM runtime_history_event WHERE account_id = ? AND workspace_id = ? AND event_id = ?",
        )
        .bind(...scope, event.id),
      writer(lease),
    ])
    const current = result[5].results[0]
    if (current?.epoch !== lease.epoch || current.writer_id !== lease.writerID) throw new HistoryError("fenced")
    const stored = result[4].results[0]
    if (!stored || stored.digest !== fingerprint) throw new HistoryError("conflict")
    return { cursor: stored.cursor }
  }

  async function read(scope: HistoryScope, input: { after?: number; limit?: number } = {}) {
    validateScope(scope)
    const after = input.after ?? 0
    const limit = input.limit ?? MAX_PAGE_ENTRIES
    integer(after)
    integer(limit, 1)
    if (limit > MAX_PAGE_ENTRIES) throw new HistoryError("invalid_input")
    const result = await batch<StoredEvent>([
      db
        .prepare(
          `SELECT cursor, event_id, session_id, seq, type, data, deleted FROM runtime_history_event
        WHERE account_id = ? AND workspace_id = ? AND cursor > ? ORDER BY cursor LIMIT ?`,
        )
        .bind(scope.accountID, scope.workspaceID, after, limit + 1),
    ])
    const entries: HistoryEntry[] = result[0].results.slice(0, limit).map((row) =>
      row.deleted === 1
        ? { cursor: row.cursor, deleted: true, aggregateID: row.session_id, id: row.event_id, seq: row.seq }
        : {
            cursor: row.cursor,
            deleted: false,
            event: {
              id: row.event_id,
              aggregateID: row.session_id,
              seq: row.seq,
              type: row.type!,
              data: JSON.parse(row.data!),
            },
          },
    )
    return { entries, cursor: entries.at(-1)?.cursor ?? after, hasMore: result[0].results.length > limit }
  }

  return { epoch, claim, append, erase, read }
}

function identifier(value: unknown) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,256}$/.test(value)) throw new HistoryError("invalid_input")
}

function integer(value: unknown, minimum = 0) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum)
    throw new HistoryError("invalid_input")
}

function validateScope(scope: HistoryScope) {
  identifier(scope.accountID)
  identifier(scope.workspaceID)
}

function validateEventID(event: Pick<HistoryEvent, "id" | "aggregateID" | "seq">) {
  identifier(event.id)
  identifier(event.aggregateID)
  integer(event.seq)
}

function validateEvent(event: HistoryEvent) {
  validateEventID(event)
  identifier(event.type)
  if (!event.data || typeof event.data !== "object" || Array.isArray(event.data))
    throw new HistoryError("invalid_input")
}

function canonical(value: unknown): string {
  function visit(input: unknown, parents: Set<object>, depth: number): unknown {
    if (input === null || typeof input === "string" || typeof input === "boolean") return input
    if (typeof input === "number" && Number.isFinite(input)) return input
    if (!input || typeof input !== "object" || depth > 48 || parents.has(input)) throw new HistoryError("invalid_input")
    if (!Array.isArray(input) && ![Object.prototype, null].includes(Object.getPrototypeOf(input)))
      throw new HistoryError("invalid_input")
    const next = new Set(parents).add(input)
    if (Array.isArray(input)) return Array.from(input, (item) => visit(item, next, depth + 1))
    return Object.fromEntries(
      Object.entries(input)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, visit(item, next, depth + 1)]),
    )
  }
  return JSON.stringify(visit(value, new Set(), 0))
}

async function digest(value: string) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}
