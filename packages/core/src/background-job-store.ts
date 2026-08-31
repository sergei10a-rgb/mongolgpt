export * as BackgroundJobStore from "./background-job-store"

import { and, eq, inArray, lte } from "drizzle-orm"
import { Clock, Effect } from "effect"
import type { BackgroundJob } from "./background-job"
import { Database } from "./database/database"
import { BackgroundJobTable } from "./background-job-store.sql"

const DEFAULT_LEASE_MS = 30_000
const MAX_OUTPUT_BYTES = 1024 * 1024
const MAX_ERROR_BYTES = 64 * 1024

type Row = typeof BackgroundJobTable.$inferSelect

export type ClaimResult = {
  claimed: boolean
  generation: number
  info: BackgroundJob.Info
}

export type Interface = {
  readonly namespace: string
  readonly leaseMs: number
  readonly list: () => Effect.Effect<BackgroundJob.Info[]>
  readonly get: (id: string) => Effect.Effect<BackgroundJob.Info | undefined>
  readonly claim: (input: { info: BackgroundJob.Info; owner: string; now?: number }) => Effect.Effect<ClaimResult>
  readonly touch: (input: { id: string; owner: string; now?: number }) => Effect.Effect<boolean>
  readonly settle: (input: {
    id: string
    owner: string
    info: BackgroundJob.Info
    now?: number
  }) => Effect.Effect<boolean>
  readonly updateMetadata: (input: {
    id: string
    owner: string
    metadata?: Record<string, unknown>
    now?: number
  }) => Effect.Effect<boolean>
  readonly recoverStale: (input?: { now?: number }) => Effect.Effect<BackgroundJob.Info[]>
  readonly abandon: (input: { id: string; now?: number }) => Effect.Effect<BackgroundJob.Info | undefined>
  readonly pruneTerminal: (input: { before: number }) => Effect.Effect<number>
}

function truncate(value: string | undefined, bytes: number) {
  if (!value) return value
  const encoded = new TextEncoder().encode(value)
  if (encoded.byteLength <= bytes) return value
  return new TextDecoder().decode(encoded.slice(0, bytes))
}

function fromRow(row: Row): BackgroundJob.Info {
  return {
    id: row.id,
    type: row.type,
    ...(row.title ? { title: row.title } : {}),
    status: row.status,
    started_at: row.started_at,
    ...(row.completed_at === null ? {} : { completed_at: row.completed_at }),
    ...(row.output === null ? {} : { output: row.output }),
    ...(row.error === null ? {} : { error: row.error }),
    ...(row.metadata === null ? {} : { metadata: { ...row.metadata } }),
  }
}

function values(input: {
  namespace: string
  info: BackgroundJob.Info
  owner: string
  generation: number
  now: number
}) {
  return {
    namespace: input.namespace,
    id: input.info.id,
    type: input.info.type,
    title: input.info.title,
    status: input.info.status,
    started_at: input.info.started_at,
    completed_at: input.info.completed_at,
    output: truncate(input.info.output, MAX_OUTPUT_BYTES),
    error: truncate(input.info.error, MAX_ERROR_BYTES),
    metadata: input.info.metadata,
    owner_token: input.owner,
    generation: input.generation,
    heartbeat_at: input.now,
    time_created: input.now,
    time_updated: input.now,
  }
}

export const make = Effect.fn("BackgroundJobStore.make")(function* (input: { namespace: string; leaseMs?: number }) {
  const namespace = input.namespace.trim()
  if (!namespace) return yield* Effect.die(new Error("Background job namespace хоосон байна"))
  const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000) {
    return yield* Effect.die(new Error("Background job lease 1000 миллисекундээс багагүй бүхэл тоо байна"))
  }
  const { db } = yield* Database.Service

  const list: Interface["list"] = Effect.fn("BackgroundJobStore.list")(function* () {
    return (yield* db
      .select()
      .from(BackgroundJobTable)
      .where(eq(BackgroundJobTable.namespace, namespace))
      .orderBy(BackgroundJobTable.started_at)
      .all()
      .pipe(Effect.orDie)).map(fromRow)
  })

  const get: Interface["get"] = Effect.fn("BackgroundJobStore.get")(function* (id) {
    const row = yield* db
      .select()
      .from(BackgroundJobTable)
      .where(and(eq(BackgroundJobTable.namespace, namespace), eq(BackgroundJobTable.id, id)))
      .get()
      .pipe(Effect.orDie)
    return row ? fromRow(row) : undefined
  })

  const claim: Interface["claim"] = Effect.fn("BackgroundJobStore.claim")(function* (claimInput) {
    const now = claimInput.now ?? (yield* Clock.currentTimeMillis)
    return yield* db
      .transaction(
        (tx) =>
          Effect.gen(function* () {
            const current = yield* tx
              .select()
              .from(BackgroundJobTable)
              .where(and(eq(BackgroundJobTable.namespace, namespace), eq(BackgroundJobTable.id, claimInput.info.id)))
              .get()
            if (current?.status === "running" && current.heartbeat_at > now - leaseMs) {
              return { claimed: false, generation: current.generation, info: fromRow(current) }
            }
            const generation = (current?.generation ?? 0) + 1
            const next = values({
              namespace,
              info: {
                ...claimInput.info,
                status: "running",
                completed_at: undefined,
                output: undefined,
                error: undefined,
              },
              owner: claimInput.owner,
              generation,
              now,
            })
            const saved = yield* tx
              .insert(BackgroundJobTable)
              .values(next)
              .onConflictDoUpdate({
                target: [BackgroundJobTable.namespace, BackgroundJobTable.id],
                set: next,
              })
              .returning()
              .get()
            if (!saved) return yield* Effect.die(new Error("Background job claim хадгалагдсангүй"))
            return { claimed: true, generation, info: fromRow(saved) }
          }),
        { behavior: "immediate" },
      )
      .pipe(Effect.orDie)
  })

  const touch: Interface["touch"] = Effect.fn("BackgroundJobStore.touch")(function* (touchInput) {
    const now = touchInput.now ?? (yield* Clock.currentTimeMillis)
    const row = yield* db
      .update(BackgroundJobTable)
      .set({ heartbeat_at: now, time_updated: now })
      .where(
        and(
          eq(BackgroundJobTable.namespace, namespace),
          eq(BackgroundJobTable.id, touchInput.id),
          eq(BackgroundJobTable.owner_token, touchInput.owner),
          eq(BackgroundJobTable.status, "running"),
        ),
      )
      .returning({ id: BackgroundJobTable.id })
      .get()
      .pipe(Effect.orDie)
    return row !== undefined
  })

  const settle: Interface["settle"] = Effect.fn("BackgroundJobStore.settle")(function* (settleInput) {
    const now = settleInput.now ?? (yield* Clock.currentTimeMillis)
    if (settleInput.info.status === "running") return false
    const row = yield* db
      .update(BackgroundJobTable)
      .set({
        status: settleInput.info.status,
        completed_at: settleInput.info.completed_at ?? now,
        output: truncate(settleInput.info.output, MAX_OUTPUT_BYTES),
        error: truncate(settleInput.info.error, MAX_ERROR_BYTES),
        metadata: settleInput.info.metadata,
        heartbeat_at: now,
        time_updated: now,
      })
      .where(
        and(
          eq(BackgroundJobTable.namespace, namespace),
          eq(BackgroundJobTable.id, settleInput.id),
          eq(BackgroundJobTable.owner_token, settleInput.owner),
          eq(BackgroundJobTable.status, "running"),
        ),
      )
      .returning({ id: BackgroundJobTable.id })
      .get()
      .pipe(Effect.orDie)
    return row !== undefined
  })

  const updateMetadata: Interface["updateMetadata"] = Effect.fn("BackgroundJobStore.updateMetadata")(
    function* (metadataInput) {
      const now = metadataInput.now ?? (yield* Clock.currentTimeMillis)
      const row = yield* db
        .update(BackgroundJobTable)
        .set({ metadata: metadataInput.metadata, heartbeat_at: now, time_updated: now })
        .where(
          and(
            eq(BackgroundJobTable.namespace, namespace),
            eq(BackgroundJobTable.id, metadataInput.id),
            eq(BackgroundJobTable.owner_token, metadataInput.owner),
            eq(BackgroundJobTable.status, "running"),
          ),
        )
        .returning({ id: BackgroundJobTable.id })
        .get()
        .pipe(Effect.orDie)
      return row !== undefined
    },
  )

  const recoverStale: Interface["recoverStale"] = Effect.fn("BackgroundJobStore.recoverStale")(
    function* (recoverInput) {
      const now = recoverInput?.now ?? (yield* Clock.currentTimeMillis)
      const stale = yield* db
        .select()
        .from(BackgroundJobTable)
        .where(
          and(
            eq(BackgroundJobTable.namespace, namespace),
            eq(BackgroundJobTable.status, "running"),
            lte(BackgroundJobTable.heartbeat_at, now - leaseMs),
          ),
        )
        .all()
        .pipe(Effect.orDie)
      return yield* Effect.forEach(stale, (current) =>
        db
          .update(BackgroundJobTable)
          .set({
            status: "recovery_required",
            completed_at: now,
            error: "Өмнөх MongolGPT процесс тасарсан тул энэ ажлыг автоматаар дахин ажиллуулаагүй.",
            metadata: { ...current.metadata, recoveryRequired: true, recoveredAt: now },
            heartbeat_at: now,
            time_updated: now,
          })
          .where(
            and(
              eq(BackgroundJobTable.namespace, namespace),
              eq(BackgroundJobTable.id, current.id),
              eq(BackgroundJobTable.owner_token, current.owner_token),
              eq(BackgroundJobTable.status, "running"),
              lte(BackgroundJobTable.heartbeat_at, now - leaseMs),
            ),
          )
          .returning()
          .get()
          .pipe(
            Effect.orDie,
            Effect.map((row) => (row ? fromRow(row) : undefined)),
          ),
      ).pipe(Effect.map((rows) => rows.filter((row): row is BackgroundJob.Info => row !== undefined)))
    },
  )

  const abandon: Interface["abandon"] = Effect.fn("BackgroundJobStore.abandon")(function* (abandonInput) {
    const now = abandonInput.now ?? (yield* Clock.currentTimeMillis)
    const row = yield* db
      .update(BackgroundJobTable)
      .set({ status: "cancelled", completed_at: now, heartbeat_at: now, time_updated: now })
      .where(
        and(
          eq(BackgroundJobTable.namespace, namespace),
          eq(BackgroundJobTable.id, abandonInput.id),
          eq(BackgroundJobTable.status, "recovery_required"),
        ),
      )
      .returning()
      .get()
      .pipe(Effect.orDie)
    return row ? fromRow(row) : yield* get(abandonInput.id)
  })

  const pruneTerminal: Interface["pruneTerminal"] = Effect.fn("BackgroundJobStore.pruneTerminal")(
    function* (pruneInput) {
      const rows = yield* db
        .delete(BackgroundJobTable)
        .where(
          and(
            eq(BackgroundJobTable.namespace, namespace),
            inArray(BackgroundJobTable.status, ["completed", "error", "cancelled"]),
            lte(BackgroundJobTable.completed_at, pruneInput.before),
          ),
        )
        .returning({ id: BackgroundJobTable.id })
        .all()
        .pipe(Effect.orDie)
      return rows.length
    },
  )

  return {
    namespace,
    leaseMs,
    list,
    get,
    claim,
    touch,
    settle,
    updateMetadata,
    recoverStale,
    abandon,
    pruneTerminal,
  } satisfies Interface
})
