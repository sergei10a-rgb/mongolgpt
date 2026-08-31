import { describe, expect } from "bun:test"
import { BackgroundJob } from "@mongolgpt/core/background-job"
import { BackgroundJobStore } from "@mongolgpt/core/background-job-store"
import { Database } from "@mongolgpt/core/database/database"
import { Deferred, Effect } from "effect"
import { it } from "./lib/effect"

const dbLayer = Database.layerFromPath(":memory:")

describe("durable BackgroundJob", () => {
  it.live("keeps completed observation across service recreation", () =>
    Effect.gen(function* () {
      const namespace = `durable-${crypto.randomUUID()}`
      const first = yield* BackgroundJob.makeDurable({ namespace, leaseMs: 1_000 })
      const started = yield* first.start({ id: "job_restart", type: "test", run: Effect.succeed("дууссан") })
      const completed = yield* first.wait({ id: started.id })
      expect(completed).toMatchObject({
        timedOut: false,
        info: { id: started.id, status: "completed", output: "дууссан" },
      })

      const second = yield* BackgroundJob.makeDurable({ namespace, leaseMs: 1_000 })
      expect(yield* second.get(started.id)).toMatchObject({
        id: started.id,
        status: "completed",
        output: "дууссан",
      })
    }).pipe(Effect.provide(dbLayer)),
  )

  it.live("does not start duplicate work while another owner has a fresh lease", () =>
    Effect.gen(function* () {
      const namespace = `durable-${crypto.randomUUID()}`
      const latch = yield* Deferred.make<void>()
      let duplicateRuns = 0
      const first = yield* BackgroundJob.makeDurable({ namespace, leaseMs: 1_000 })
      const second = yield* BackgroundJob.makeDurable({ namespace, leaseMs: 1_000 })
      const started = yield* first.start({
        id: "job_fresh_owner",
        type: "test",
        run: Deferred.await(latch).pipe(Effect.as("owner-a")),
      })
      const duplicate = yield* second.start({
        id: started.id,
        type: "test",
        run: Effect.sync(() => {
          duplicateRuns += 1
          return "owner-b"
        }),
      })

      expect(duplicate).toMatchObject({ id: started.id, status: "running" })
      expect(duplicateRuns).toBe(0)
      yield* Deferred.succeed(latch, undefined)
      expect(yield* first.wait({ id: started.id })).toMatchObject({
        info: { status: "completed", output: "owner-a" },
      })
      expect(yield* second.wait({ id: started.id })).toMatchObject({
        info: { status: "completed", output: "owner-a" },
      })
    }).pipe(Effect.provide(dbLayer)),
  )

  it.live("surfaces stale unknown work without replaying its effect", () =>
    Effect.gen(function* () {
      const namespace = `durable-${crypto.randomUUID()}`
      const now = Date.now()
      const store = yield* BackgroundJobStore.make({ namespace, leaseMs: 1_000 })
      yield* store.claim({
        owner: "crashed-owner",
        now: now - 2_000,
        info: {
          id: "job_unknown",
          type: "test",
          status: "running",
          started_at: now - 2_000,
          metadata: { source: "before-restart" },
        },
      })

      let runs = 0
      const recovered = yield* BackgroundJob.makeDurable({ namespace, leaseMs: 1_000 })
      const info = yield* recovered.get("job_unknown")
      expect(info).toMatchObject({
        status: "recovery_required",
        metadata: { source: "before-restart", recoveryRequired: true },
      })
      expect(runs).toBe(0)

      const retried = yield* recovered.start({
        id: "job_unknown",
        type: "test",
        run: Effect.sync(() => {
          runs += 1
          return "explicit-retry"
        }),
      })
      expect(yield* recovered.wait({ id: retried.id })).toMatchObject({
        info: { status: "completed", output: "explicit-retry" },
      })
      expect(runs).toBe(1)
    }).pipe(Effect.provide(dbLayer)),
  )

  it.live("does not report promotion success for work owned by another process", () =>
    Effect.gen(function* () {
      const namespace = `durable-${crypto.randomUUID()}`
      const now = Date.now()
      const store = yield* BackgroundJobStore.make({ namespace, leaseMs: 1_000 })
      yield* store.claim({
        owner: "other-process",
        now,
        info: {
          id: "job_other_owner",
          type: "test",
          status: "running",
          started_at: now,
        },
      })

      const observer = yield* BackgroundJob.makeDurable({ namespace, leaseMs: 1_000 })
      expect(yield* observer.promote("job_other_owner")).toBeUndefined()
      const persisted = yield* store.get("job_other_owner")
      expect(persisted).toMatchObject({ status: "running" })
      expect(persisted?.metadata).toBeUndefined()
    }).pipe(Effect.provide(dbLayer)),
  )

  it.live("returns a locally completed job without waiting for promotion", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.makeDurable({
        namespace: `durable-${crypto.randomUUID()}`,
        leaseMs: 1_000,
      })
      yield* jobs.start({ id: "job_completed_before_promotion", type: "test", run: Effect.succeed("done") })
      yield* jobs.wait({ id: "job_completed_before_promotion" })

      expect(yield* jobs.waitForPromotion("job_completed_before_promotion")).toMatchObject({
        id: "job_completed_before_promotion",
        status: "completed",
        output: "done",
      })
    }).pipe(Effect.provide(dbLayer)),
  )

  it.live("rejects promotion after the local owner loses its lease", () =>
    Effect.gen(function* () {
      const namespace = `durable-${crypto.randomUUID()}`
      const promoted = yield* Deferred.make<void>()
      const work = yield* Deferred.make<void>()
      const jobs = yield* BackgroundJob.makeDurable({ namespace, leaseMs: 1_000 })
      const info = yield* jobs.start({
        id: "job_lost_lease",
        type: "test",
        onPromote: Deferred.succeed(promoted, undefined),
        run: Deferred.await(work).pipe(Effect.as("done")),
      })
      const store = yield* BackgroundJobStore.make({ namespace, leaseMs: 1_000 })
      yield* store.recoverStale({ now: Date.now() + 2_000 })

      expect(yield* jobs.promote(info.id)).toBeUndefined()
      expect(yield* Deferred.isDone(promoted)).toBe(false)
      expect(yield* store.get(info.id)).toMatchObject({ status: "recovery_required" })
      yield* Deferred.succeed(work, undefined)
    }).pipe(Effect.provide(dbLayer)),
  )

  it.live("never exposes stale local state after the owner loses its lease", () =>
    Effect.gen(function* () {
      const namespace = `durable-${crypto.randomUUID()}`
      const interrupted = yield* Deferred.make<void>()
      const jobs = yield* BackgroundJob.makeDurable({ namespace, leaseMs: 1_000 })
      const info = yield* jobs.start({
        id: "job_stale_observation",
        type: "test",
        run: Effect.never.pipe(Effect.ensuring(Deferred.succeed(interrupted, undefined))),
      })
      const store = yield* BackgroundJobStore.make({ namespace, leaseMs: 1_000 })
      yield* store.recoverStale({ now: Date.now() + 2_000 })

      expect(yield* jobs.get(info.id)).toMatchObject({ status: "recovery_required" })
      expect(yield* Deferred.isDone(interrupted)).toBe(true)
      expect(yield* jobs.list()).toEqual([expect.objectContaining({ id: info.id, status: "recovery_required" })])
      expect(yield* jobs.wait({ id: info.id })).toMatchObject({
        timedOut: false,
        info: { status: "recovery_required" },
      })
    }).pipe(Effect.provide(dbLayer)),
  )

  it.live("does not report cancellation success after another owner wins the lease", () =>
    Effect.gen(function* () {
      const namespace = `durable-${crypto.randomUUID()}`
      const jobs = yield* BackgroundJob.makeDurable({ namespace, leaseMs: 1_000 })
      const info = yield* jobs.start({ id: "job_stale_cancel", type: "test", run: Effect.never })
      const store = yield* BackgroundJobStore.make({ namespace, leaseMs: 1_000 })
      yield* store.recoverStale({ now: Date.now() + 2_000 })

      expect(yield* jobs.cancel(info.id)).toMatchObject({ status: "recovery_required" })
      expect(yield* store.get(info.id)).toMatchObject({ status: "recovery_required" })
    }).pipe(Effect.provide(dbLayer)),
  )

  it.live("starts a new generation on the first explicit retry after local lease loss", () =>
    Effect.gen(function* () {
      const namespace = `durable-${crypto.randomUUID()}`
      const interrupted = yield* Deferred.make<void>()
      const jobs = yield* BackgroundJob.makeDurable({ namespace, leaseMs: 1_000 })
      const first = yield* jobs.start({
        id: "job_explicit_retry",
        type: "test",
        run: Effect.never.pipe(Effect.ensuring(Deferred.succeed(interrupted, undefined))),
      })
      const store = yield* BackgroundJobStore.make({ namespace, leaseMs: 1_000 })
      yield* store.recoverStale({ now: Date.now() + 2_000 })

      const retried = yield* jobs.start({
        id: first.id,
        type: "test",
        run: Effect.succeed("retried"),
      })

      expect(yield* Deferred.isDone(interrupted)).toBe(true)
      expect(retried).toMatchObject({ id: first.id, status: "running" })
      expect(yield* jobs.wait({ id: first.id })).toMatchObject({
        timedOut: false,
        info: { status: "completed", output: "retried" },
      })
    }).pipe(Effect.provide(dbLayer)),
  )

  it.live("renews a one-second lease before it can expire", () =>
    Effect.gen(function* () {
      const jobs = yield* BackgroundJob.makeDurable({
        namespace: `durable-${crypto.randomUUID()}`,
        leaseMs: 1_000,
      })
      const info = yield* jobs.start({
        id: "job_short_lease",
        type: "test",
        run: Effect.sleep(1_300).pipe(Effect.as("done")),
      })

      expect(yield* jobs.wait({ id: info.id })).toMatchObject({
        timedOut: false,
        info: { status: "completed", output: "done" },
      })
    }).pipe(Effect.provide(dbLayer)),
  )
})
