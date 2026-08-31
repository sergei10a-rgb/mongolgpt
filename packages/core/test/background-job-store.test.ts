import { describe, expect, test } from "bun:test"
import { BackgroundJob } from "@mongolgpt/core/background-job"
import { BackgroundJobStore } from "@mongolgpt/core/background-job-store"
import { Database } from "@mongolgpt/core/database/database"
import { Effect } from "effect"
import path from "path"
import { it } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const leaseMs = 2_000
const dbLayer = Database.layerFromPath(":memory:")

type JobInfo = BackgroundJob.Info

function runningJob(id: string, startedAt: number, metadata?: Record<string, unknown>): JobInfo {
  return {
    id,
    type: "test",
    status: "running",
    started_at: startedAt,
    ...(metadata ? { metadata } : {}),
  }
}

function completedJob(
  id: string,
  startedAt: number,
  completedAt: number,
  output: string,
  metadata?: Record<string, unknown>,
): JobInfo {
  return {
    id,
    type: "test",
    status: "completed",
    started_at: startedAt,
    completed_at: completedAt,
    output,
    ...(metadata ? { metadata } : {}),
  }
}

describe("BackgroundJobStore", () => {
  test("serializes concurrent claims from separate sqlite connections", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "background-job.sqlite")
    const namespace = `bg-store-${crypto.randomUUID()}`
    const startedAt = 1_700_000_000_000
    const claim = (owner: string) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* BackgroundJobStore.make({ namespace, leaseMs })
          return yield* store.claim({
            info: runningJob("job-concurrent", startedAt),
            owner,
            now: startedAt,
          })
        }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped),
      )

    const results = await Promise.all([claim("owner-a"), claim("owner-b")])
    expect(results.filter((result) => result.claimed)).toHaveLength(1)
    expect(results.filter((result) => !result.claimed)).toHaveLength(1)
    expect(results.map((result) => result.generation)).toEqual([1, 1])
  })

  it.effect("persists running jobs across a fresh store instance that shares the same database", () =>
    Effect.gen(function* () {
      const namespace = `bg-store-${crypto.randomUUID()}`
      const startedAt = 1_700_000_000_000
      const first = yield* BackgroundJobStore.make({ namespace, leaseMs })
      const claim = yield* first.claim({
        info: runningJob("job-persist", startedAt, { phase: "running" }),
        owner: "owner-a",
        now: startedAt,
      })

      expect(first.namespace).toBe(namespace)
      expect(first.leaseMs).toBe(leaseMs)
      expect(claim).toMatchObject({
        claimed: true,
        generation: 1,
        info: {
          id: "job-persist",
          type: "test",
          status: "running",
          started_at: startedAt,
          metadata: { phase: "running" },
        },
      })

      const second = yield* BackgroundJobStore.make({ namespace, leaseMs })
      expect(yield* second.list()).toEqual([claim.info])
      expect(yield* second.get(claim.info.id)).toEqual(claim.info)
    }).pipe(Effect.provide(dbLayer)),
  )

  it.effect("increments generation for a stale claim and fences the old owner from settling", () =>
    Effect.gen(function* () {
      const namespace = `bg-store-${crypto.randomUUID()}`
      const startedAt = 1_700_000_100_000
      const staleAt = startedAt + leaseMs + 1
      const first = yield* BackgroundJobStore.make({ namespace, leaseMs })
      const firstClaim = yield* first.claim({
        info: runningJob("job-stale", startedAt, { phase: "first" }),
        owner: "owner-a",
        now: startedAt,
      })
      const second = yield* BackgroundJobStore.make({ namespace, leaseMs })
      const secondClaim = yield* second.claim({
        info: runningJob("job-stale", staleAt, { phase: "second" }),
        owner: "owner-b",
        now: staleAt,
      })

      expect(secondClaim).toMatchObject({
        claimed: true,
        generation: 2,
        info: {
          id: "job-stale",
          type: "test",
          status: "running",
          started_at: staleAt,
          metadata: { phase: "second" },
        },
      })
      expect(
        yield* first.settle({
          id: "job-stale",
          owner: "owner-a",
          info: completedJob("job-stale", staleAt, staleAt + 1, "old-result", { phase: "old" }),
          now: staleAt + 1,
        }),
      ).toBe(false)
      expect(yield* second.get("job-stale")).toEqual(secondClaim.info)
      expect(firstClaim.generation).toBe(1)
    }).pipe(Effect.provide(dbLayer)),
  )

  it.effect("rejects a fresh lease claim from another owner", () =>
    Effect.gen(function* () {
      const namespace = `bg-store-${crypto.randomUUID()}`
      const startedAt = 1_700_000_200_000
      const freshAt = startedAt + leaseMs - 1
      const first = yield* BackgroundJobStore.make({ namespace, leaseMs })
      const firstClaim = yield* first.claim({
        info: runningJob("job-fresh", startedAt, { phase: "owner-a" }),
        owner: "owner-a",
        now: startedAt,
      })
      const second = yield* BackgroundJobStore.make({ namespace, leaseMs })
      const secondClaim = yield* second.claim({
        info: runningJob("job-fresh", freshAt, { phase: "ignored" }),
        owner: "owner-b",
        now: freshAt,
      })

      expect(secondClaim).toEqual({ claimed: false, generation: 1, info: firstClaim.info })
      expect(yield* second.get("job-fresh")).toEqual(firstClaim.info)
    }).pipe(Effect.provide(dbLayer)),
  )

  it.effect("allows a new owner at the exact lease boundary", () =>
    Effect.gen(function* () {
      const namespace = `bg-store-${crypto.randomUUID()}`
      const startedAt = 1_700_000_250_000
      const boundary = startedAt + leaseMs
      const store = yield* BackgroundJobStore.make({ namespace, leaseMs })
      yield* store.claim({
        info: runningJob("job-boundary", startedAt),
        owner: "owner-a",
        now: startedAt,
      })

      expect(yield* store.recoverStale({ now: boundary })).toMatchObject([
        { id: "job-boundary", status: "recovery_required" },
      ])
      const claim = yield* store.claim({
        info: runningJob("job-boundary", boundary),
        owner: "owner-b",
        now: boundary,
      })
      expect(claim).toMatchObject({ claimed: true, generation: 2, info: { status: "running" } })
    }).pipe(Effect.provide(dbLayer)),
  )

  it.effect("marks stale rows as recovery_required after restart without replaying work", () =>
    Effect.gen(function* () {
      const namespace = `bg-store-${crypto.randomUUID()}`
      const startedAt = 1_700_000_300_000
      const recoveredAt = startedAt + leaseMs + 1
      const first = yield* BackgroundJobStore.make({ namespace, leaseMs })
      const claim = yield* first.claim({
        info: runningJob("job-recover", startedAt, { source: "crash" }),
        owner: "owner-a",
        now: startedAt,
      })

      const second = yield* BackgroundJobStore.make({ namespace, leaseMs })
      const recovered = yield* second.recoverStale({ now: recoveredAt })
      expect(recovered).toMatchObject([
        {
          id: "job-recover",
          status: "recovery_required",
          completed_at: recoveredAt,
          metadata: {
            source: "crash",
            recoveryRequired: true,
            recoveredAt,
          },
        },
      ])

      const third = yield* BackgroundJobStore.make({ namespace, leaseMs })
      expect(yield* third.get(claim.info.id)).toMatchObject({
        id: "job-recover",
        status: "recovery_required",
        completed_at: recoveredAt,
        metadata: {
          source: "crash",
          recoveryRequired: true,
          recoveredAt,
        },
      })
    }).pipe(Effect.provide(dbLayer)),
  )

  it.effect("preserves completed output and metadata across restart", () =>
    Effect.gen(function* () {
      const namespace = `bg-store-${crypto.randomUUID()}`
      const startedAt = 1_700_000_400_000
      const completedAt = startedAt + 5_000
      const first = yield* BackgroundJobStore.make({ namespace, leaseMs })
      const claim = yield* first.claim({
        info: runningJob("job-complete", startedAt, { stage: "draft" }),
        owner: "owner-a",
        now: startedAt,
      })

      expect(
        yield* first.settle({
          id: claim.info.id,
          owner: "owner-a",
          info: completedJob("job-complete", startedAt, completedAt, "final-output", {
            stage: "done",
            nested: { keep: true },
          }),
          now: completedAt,
        }),
      ).toBe(true)

      const second = yield* BackgroundJobStore.make({ namespace, leaseMs })
      expect(yield* second.get(claim.info.id)).toEqual({
        id: "job-complete",
        type: "test",
        status: "completed",
        started_at: startedAt,
        completed_at: completedAt,
        output: "final-output",
        metadata: {
          stage: "done",
          nested: { keep: true },
        },
      })
      expect(yield* second.list()).toEqual([
        {
          id: "job-complete",
          type: "test",
          status: "completed",
          started_at: startedAt,
          completed_at: completedAt,
          output: "final-output",
          metadata: {
            stage: "done",
            nested: { keep: true },
          },
        },
      ])
    }).pipe(Effect.provide(dbLayer)),
  )

  it.effect("keeps namespaces isolated even when they share the same sqlite database", () =>
    Effect.gen(function* () {
      const namespaceA = `bg-store-a-${crypto.randomUUID()}`
      const namespaceB = `bg-store-b-${crypto.randomUUID()}`
      const startedAt = 1_700_000_500_000
      const storeA = yield* BackgroundJobStore.make({ namespace: namespaceA, leaseMs })
      const storeB = yield* BackgroundJobStore.make({ namespace: namespaceB, leaseMs })

      const jobA = yield* storeA.claim({
        info: runningJob("job-a", startedAt, { namespace: "A" }),
        owner: "owner-a",
        now: startedAt,
      })
      const jobB = yield* storeB.claim({
        info: runningJob("job-b", startedAt, { namespace: "B" }),
        owner: "owner-b",
        now: startedAt,
      })

      expect(yield* storeA.list()).toEqual([jobA.info])
      expect(yield* storeB.list()).toEqual([jobB.info])
      expect(yield* storeA.get(jobB.info.id)).toBeUndefined()
      expect(yield* storeB.get(jobA.info.id)).toBeUndefined()
    }).pipe(Effect.provide(dbLayer)),
  )

  it.effect("fences metadata updates to the owning token", () =>
    Effect.gen(function* () {
      const namespace = `bg-store-${crypto.randomUUID()}`
      const startedAt = 1_700_000_600_000
      const updatedAt = startedAt + 2_000
      const store = yield* BackgroundJobStore.make({ namespace, leaseMs })
      const claim = yield* store.claim({
        info: runningJob("job-meta", startedAt, { step: "initial" }),
        owner: "owner-a",
        now: startedAt,
      })

      expect(
        yield* store.updateMetadata({
          id: claim.info.id,
          owner: "owner-b",
          metadata: { step: "wrong-owner" },
          now: updatedAt,
        }),
      ).toBe(false)
      expect(yield* store.get(claim.info.id)).toEqual(claim.info)

      expect(
        yield* store.updateMetadata({
          id: claim.info.id,
          owner: "owner-a",
          metadata: { step: "updated", nested: { keep: true } },
          now: updatedAt + 1,
        }),
      ).toBe(true)
      expect(yield* store.get(claim.info.id)).toMatchObject({
        metadata: { step: "updated", nested: { keep: true } },
      })
    }).pipe(Effect.provide(dbLayer)),
  )

  it.effect("prunes only old terminal rows and preserves recovery decisions", () =>
    Effect.gen(function* () {
      const namespace = `bg-store-${crypto.randomUUID()}`
      const startedAt = 1_700_000_700_000
      const store = yield* BackgroundJobStore.make({ namespace, leaseMs })

      for (const [id, completedAt] of [
        ["job-old", startedAt + 1_000],
        ["job-recent", startedAt + 10_000],
      ] as const) {
        yield* store.claim({ info: runningJob(id, startedAt), owner: id, now: startedAt })
        yield* store.settle({
          id,
          owner: id,
          info: completedJob(id, startedAt, completedAt, id),
          now: completedAt,
        })
      }
      yield* store.claim({
        info: runningJob("job-recovery", startedAt),
        owner: "crashed-owner",
        now: startedAt,
      })
      yield* store.recoverStale({ now: startedAt + leaseMs })

      expect(yield* store.pruneTerminal({ before: startedAt + 5_000 })).toBe(1)
      expect(yield* store.get("job-old")).toBeUndefined()
      expect(yield* store.get("job-recent")).toMatchObject({ status: "completed" })
      expect(yield* store.get("job-recovery")).toMatchObject({ status: "recovery_required" })
    }).pipe(Effect.provide(dbLayer)),
  )
})
