export * as BackgroundJob from "./background-job"

import { Cause, Clock, Context, Deferred, Effect, Exit, Layer, Scope, SynchronizedRef } from "effect"
import { Identifier } from "./id/id"
import { makeGlobalNode } from "./effect/node"
import { BackgroundJobStore } from "./background-job-store"

export type Status = "running" | "completed" | "error" | "cancelled" | "recovery_required"

export type Info = {
  id: string
  type: string
  title?: string
  status: Status
  started_at: number
  completed_at?: number
  output?: string
  error?: string
  metadata?: Record<string, unknown>
}

type Active = {
  info: Info
  done: Deferred.Deferred<Info>
  scope: Scope.Closeable
  token: object
  pending: number
  next: number
  output?: { sequence: number; text: string }
  tail: Deferred.Deferred<void>
  promoted: Deferred.Deferred<Info>
  onPromote?: Effect.Effect<void>
}

type State = {
  jobs: SynchronizedRef.SynchronizedRef<Map<string, Active>>
  scope: Scope.Scope
}

type FinishResult = {
  info?: Info
  done?: Deferred.Deferred<Info>
  scope?: Scope.Closeable
}

type PromoteResult = {
  info?: Info
  promoted?: Deferred.Deferred<Info>
  onPromote?: Effect.Effect<void>
}

type StartResult = { info: Info } | { info: Info; scope: Scope.Closeable; token: object }

type ExtendResult =
  | { extended: false }
  | {
      extended: true
      previous: Deferred.Deferred<void>
      scope: Scope.Closeable
      tail: Deferred.Deferred<void>
      token: object
      sequence: number
    }

export type StartInput = {
  id?: string
  type: string
  title?: string
  metadata?: Record<string, unknown>
  onPromote?: Effect.Effect<void>
  run: Effect.Effect<string, unknown>
}

export type ExtendInput = {
  id: string
  run: Effect.Effect<string, unknown>
}

export type WaitInput = {
  id: string
  timeout?: number
}

export type WaitResult = {
  info?: Info
  timedOut: boolean
}

export interface Interface {
  readonly list: () => Effect.Effect<Info[]>
  readonly get: (id: string) => Effect.Effect<Info | undefined>
  readonly start: (input: StartInput) => Effect.Effect<Info>
  readonly extend: (input: ExtendInput) => Effect.Effect<boolean>
  readonly wait: (input: WaitInput) => Effect.Effect<WaitResult>
  readonly waitForPromotion: (id: string) => Effect.Effect<Info>
  readonly promote: (id: string) => Effect.Effect<Info | undefined>
  readonly cancel: (id: string) => Effect.Effect<Info | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@mongolgpt/BackgroundJob") {}

function snapshot(job: Active): Info {
  return {
    ...job.info,
    ...(job.info.metadata ? { metadata: { ...job.info.metadata } } : {}),
  }
}

function errorText(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Makes one scoped, process-local registry. Entries are intentionally not
 * durable: process restart or owner-scope closure loses status and interrupts
 * live work. Persisted observation, restart recovery, and remote workers need a
 * separate durable ownership slice rather than pretending this registry has
 * those semantics.
 */
export const make = Effect.gen(function* () {
  const state: State = {
    jobs: yield* SynchronizedRef.make(new Map()),
    scope: yield* Scope.Scope,
  }

  const settle = Effect.fn("BackgroundJob.settle")(function* (
    id: string,
    token: object,
    sequence: number,
    exit: Exit.Exit<string, unknown>,
  ) {
    const completed_at = yield* Clock.currentTimeMillis
    const result = yield* SynchronizedRef.modify(state.jobs, (jobs): readonly [FinishResult, Map<string, Active>] => {
      const job = jobs.get(id)
      if (!job) return [{}, jobs]
      if (job.token !== token) return [{}, jobs]
      if (job.info.status !== "running") return [{ info: snapshot(job) }, jobs]
      const pending = job.pending - 1
      const output =
        Exit.isSuccess(exit) && (!job.output || sequence > job.output.sequence)
          ? { sequence, text: exit.value }
          : job.output
      if (Exit.isSuccess(exit) && pending > 0) {
        return [{}, new Map(jobs).set(id, { ...job, pending, output })]
      }
      const status: Exclude<Status, "running"> = Exit.isSuccess(exit)
        ? "completed"
        : Cause.hasInterruptsOnly(exit.cause)
          ? "cancelled"
          : "error"
      const next = {
        ...job,
        onPromote: undefined,
        pending: 0,
        output,
        info: {
          ...job.info,
          status,
          completed_at,
          ...(output ? { output: output.text } : {}),
          ...(Exit.isFailure(exit) ? { error: errorText(Cause.squash(exit.cause)) } : {}),
        },
      }
      return [{ info: snapshot(next), done: job.done, scope: job.scope }, new Map(jobs).set(id, next)]
    })
    if (result.info && result.done) yield* Deferred.succeed(result.done, result.info).pipe(Effect.ignore)
    if (result.scope) {
      yield* Scope.close(result.scope, Exit.void).pipe(Effect.forkIn(state.scope, { startImmediately: true }))
    }
    return result.info
  })

  const fork = Effect.fn("BackgroundJob.fork")(function* (
    scope: Scope.Scope,
    id: string,
    token: object,
    sequence: number,
    run: Effect.Effect<string, unknown>,
  ) {
    return yield* run.pipe(
      Effect.matchCauseEffect({
        onSuccess: (output) => settle(id, token, sequence, Exit.succeed(output)),
        onFailure: (cause) => settle(id, token, sequence, Exit.failCause(cause)),
      }),
      Effect.asVoid,
      Effect.forkIn(scope, { startImmediately: true }),
    )
  })

  const list: Interface["list"] = Effect.fn("BackgroundJob.list")(function* () {
    return Array.from((yield* SynchronizedRef.get(state.jobs)).values())
      .map(snapshot)
      .toSorted((a, b) => a.started_at - b.started_at)
  })

  const get: Interface["get"] = Effect.fn("BackgroundJob.get")(function* (id) {
    const job = (yield* SynchronizedRef.get(state.jobs)).get(id)
    if (!job) return
    return snapshot(job)
  })

  const start: Interface["start"] = Effect.fn("BackgroundJob.start")(function* (input) {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const id = input.id ?? Identifier.ascending("job")
        const started_at = yield* Clock.currentTimeMillis
        const done = yield* Deferred.make<Info>()
        const promoted = yield* Deferred.make<Info>()
        const tail = yield* Deferred.make<void>()
        const result = yield* SynchronizedRef.modifyEffect(
          state.jobs,
          Effect.fnUntraced(function* (jobs) {
            const existing = jobs.get(id)
            if (existing?.info.status === "running") {
              return [{ info: snapshot(existing) }, jobs] as readonly [StartResult, Map<string, Active>]
            }
            const scope = yield* Scope.fork(state.scope, "parallel")
            const token = {}
            const job = {
              info: {
                id,
                type: input.type,
                title: input.title,
                status: "running" as const,
                started_at,
                metadata: input.metadata,
              },
              done,
              scope,
              token,
              pending: 1,
              next: 1,
              tail,
              promoted,
              onPromote: input.onPromote,
            }
            return [{ info: snapshot(job), scope, token }, new Map(jobs).set(id, job)] as readonly [
              StartResult,
              Map<string, Active>,
            ]
          }),
        )
        if ("scope" in result)
          yield* fork(
            result.scope,
            id,
            result.token,
            0,
            restore(input.run).pipe(Effect.ensuring(Deferred.succeed(tail, undefined))),
          )
        return result.info
      }),
    )
  })

  const extend: Interface["extend"] = Effect.fn("BackgroundJob.extend")(function* (input) {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const tail = yield* Deferred.make<void>()
        const result = yield* SynchronizedRef.modify(
          state.jobs,
          (jobs): readonly [ExtendResult, Map<string, Active>] => {
            const job = jobs.get(input.id)
            if (!job || job.info.status !== "running") return [{ extended: false }, jobs]
            return [
              { extended: true, previous: job.tail, scope: job.scope, tail, token: job.token, sequence: job.next },
              new Map(jobs).set(input.id, {
                ...job,
                pending: job.pending + 1,
                next: job.next + 1,
                tail,
              }),
            ]
          },
        )
        if (!result.extended) return false
        yield* fork(
          result.scope,
          input.id,
          result.token,
          result.sequence,
          Deferred.await(result.previous).pipe(
            Effect.andThen(restore(input.run)),
            Effect.ensuring(Deferred.succeed(result.tail, undefined)),
          ),
        )
        return true
      }),
    )
  })

  const wait: Interface["wait"] = Effect.fn("BackgroundJob.wait")(function* (input) {
    const job = (yield* SynchronizedRef.get(state.jobs)).get(input.id)
    if (!job) return { timedOut: false }
    if (job.info.status !== "running") return { info: snapshot(job), timedOut: false }
    if (input.timeout === undefined) return { info: yield* Deferred.await(job.done), timedOut: false }
    if (input.timeout <= 0) return { info: snapshot(job), timedOut: true }
    const info = yield* Deferred.await(job.done).pipe(Effect.timeoutOption(input.timeout))
    if (info._tag === "Some") return { info: info.value, timedOut: false }
    return { info: snapshot(job), timedOut: true }
  })

  const waitForPromotion: Interface["waitForPromotion"] = Effect.fn("BackgroundJob.waitForPromotion")(function* (id) {
    const job = (yield* SynchronizedRef.get(state.jobs)).get(id)
    if (!job || job.info.status !== "running") return yield* Effect.never
    if (job.info.metadata?.background === true) return snapshot(job)
    return yield* Deferred.await(job.promoted)
  })

  const promote: Interface["promote"] = Effect.fn("BackgroundJob.promote")(function* (id) {
    const result = yield* SynchronizedRef.modifyEffect(
      state.jobs,
      Effect.fnUntraced(function* (jobs) {
        const job = jobs.get(id)
        if (!job || job.info.status !== "running") return [{}, jobs] as readonly [PromoteResult, Map<string, Active>]
        if (job.info.metadata?.background === true)
          return [{ info: snapshot(job) }, jobs] as readonly [PromoteResult, Map<string, Active>]
        const next = {
          ...job,
          onPromote: undefined,
          info: {
            ...job.info,
            metadata: { ...job.info.metadata, background: true },
          },
        }
        return [
          { info: snapshot(next), onPromote: job.onPromote, promoted: job.promoted },
          new Map(jobs).set(id, next),
        ] as readonly [PromoteResult, Map<string, Active>]
      }),
    )
    if (result.info && result.promoted) yield* Deferred.succeed(result.promoted, result.info).pipe(Effect.ignore)
    if (result.onPromote) yield* result.onPromote.pipe(Effect.ignore)
    return result.info
  })

  const cancel: Interface["cancel"] = Effect.fn("BackgroundJob.cancel")(function* (id) {
    const completed_at = yield* Clock.currentTimeMillis
    const result = yield* SynchronizedRef.modify(state.jobs, (jobs): readonly [FinishResult, Map<string, Active>] => {
      const job = jobs.get(id)
      if (!job) return [{}, jobs]
      if (job.info.status !== "running") return [{ info: snapshot(job) }, jobs]
      const next = {
        ...job,
        onPromote: undefined,
        pending: 0,
        info: {
          ...job.info,
          status: "cancelled" as const,
          completed_at,
        },
      }
      return [{ info: snapshot(next), done: job.done, scope: job.scope }, new Map(jobs).set(id, next)]
    })
    if (result.info && result.done) yield* Deferred.succeed(result.done, result.info).pipe(Effect.ignore)
    if (result.scope) yield* Scope.close(result.scope, Exit.void)
    return result.info
  })

  return Service.of({ list, get, start, extend, wait, waitForPromotion, promote, cancel })
})

const DURABLE_POLL_MS = 200
const DURABLE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000

/**
 * Adds SQLite observation and lease fencing around the process-local engine.
 * Unknown work is never replayed after a crash; an expired owner becomes
 * recovery_required and a later explicit start creates a new fenced generation.
 */
export const makeDurable = Effect.fn("BackgroundJob.makeDurable")(function* (input: {
  namespace: string
  leaseMs?: number
}) {
  const local = yield* make
  const store = yield* BackgroundJobStore.make(input)
  const scope = yield* Scope.Scope
  const owners = new Map<string, string>()
  const heartbeatEvery = Math.max(100, Math.floor(store.leaseMs / 3))

  const initializedAt = yield* Clock.currentTimeMillis
  yield* store.pruneTerminal({ before: initializedAt - DURABLE_RETENTION_MS })
  const recover = store.recoverStale().pipe(Effect.asVoid)
  const renew = Effect.fn("BackgroundJob.renewOwner")(function* (id: string, owner: string) {
    const active = yield* store.touch({ id, owner })
    if (active) return true
    if (owners.get(id) === owner) owners.delete(id)
    yield* local.cancel(id).pipe(Effect.asVoid)
    return false
  })
  yield* recover
  yield* Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(heartbeatEvery)
      yield* Effect.forEach([...owners], ([id, owner]) => renew(id, owner))
      yield* recover
    }
  }).pipe(Effect.forkIn(scope, { startImmediately: true }))

  const persisted = Effect.fn("BackgroundJob.persisted")(function* (id: string) {
    yield* recover
    return yield* store.get(id)
  })

  const monitor = Effect.fn("BackgroundJob.monitor")(function* (id: string, owner: string) {
    yield* local.wait({ id }).pipe(
      Effect.flatMap((result) =>
        result.info ? store.settle({ id, owner, info: result.info }).pipe(Effect.asVoid) : Effect.void,
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (owners.get(id) === owner) owners.delete(id)
        }),
      ),
    )
  })

  const list: Interface["list"] = Effect.fn("BackgroundJob.durableList")(function* () {
    yield* recover
    const [saved, active] = yield* Effect.all([store.list(), local.list()])
    const merged = new Map(saved.map((job) => [job.id, job]))
    for (const job of active) {
      const owner = owners.get(job.id)
      if (owner && (yield* renew(job.id, owner))) {
        merged.set(job.id, job)
        continue
      }
      const latest = yield* persisted(job.id)
      if (latest) merged.set(job.id, latest)
      else merged.delete(job.id)
    }
    return [...merged.values()].toSorted((a, b) => a.started_at - b.started_at)
  })

  const get: Interface["get"] = Effect.fn("BackgroundJob.durableGet")(function* (id) {
    const active = yield* local.get(id)
    const owner = owners.get(id)
    if (active && owner && (yield* renew(id, owner))) return active
    if (active?.status === "running") yield* local.cancel(id).pipe(Effect.asVoid)
    return yield* persisted(id)
  })

  const start: Interface["start"] = Effect.fn("BackgroundJob.durableStart")(function* (startInput) {
    const id = startInput.id ?? Identifier.ascending("job")
    const active = yield* local.get(id)
    if (active?.status === "running") {
      const current = yield* get(id)
      if (current?.status === "running") return current
    }
    const owner = crypto.randomUUID()
    const started_at = yield* Clock.currentTimeMillis
    const claim = yield* store.claim({
      owner,
      info: {
        id,
        type: startInput.type,
        title: startInput.title,
        status: "running",
        started_at,
        metadata: startInput.metadata,
      },
    })
    if (!claim.claimed) return claim.info
    owners.set(id, owner)
    const launched = yield* Effect.exit(local.start({ ...startInput, id }))
    if (Exit.isFailure(launched)) {
      owners.delete(id)
      const completed_at = yield* Clock.currentTimeMillis
      yield* store.settle({
        id,
        owner,
        info: {
          id,
          type: startInput.type,
          title: startInput.title,
          status: Cause.hasInterruptsOnly(launched.cause) ? "cancelled" : "error",
          started_at,
          completed_at,
          error: errorText(Cause.squash(launched.cause)),
          metadata: startInput.metadata,
        },
      })
      return yield* Effect.failCause(launched.cause)
    }
    const info = launched.value
    yield* monitor(id, owner).pipe(Effect.forkIn(scope, { startImmediately: true }))
    return info
  })

  const extend: Interface["extend"] = Effect.fn("BackgroundJob.durableExtend")(function* (extendInput) {
    const owner = owners.get(extendInput.id)
    if (!owner) return false
    if (!(yield* renew(extendInput.id, owner))) return false
    return yield* local.extend(extendInput)
  })

  const wait: Interface["wait"] = Effect.fn("BackgroundJob.durableWait")(function* (waitInput) {
    const active = yield* local.get(waitInput.id)
    const owner = owners.get(waitInput.id)
    if (active && owner && (yield* renew(waitInput.id, owner))) {
      const result = yield* local.wait(waitInput)
      if (!result.info) return result
      if (result.info.status === "running") {
        if (yield* renew(waitInput.id, owner)) return result
      } else {
        const settled = yield* store.settle({ id: waitInput.id, owner, info: result.info })
        if (settled) {
          if (owners.get(waitInput.id) === owner) owners.delete(waitInput.id)
          return result
        }
      }
      const info = yield* persisted(waitInput.id)
      return { info, timedOut: result.timedOut && info?.status === "running" }
    }
    if (active?.status === "running") yield* local.cancel(waitInput.id).pipe(Effect.asVoid)
    const started = yield* Clock.currentTimeMillis
    while (true) {
      const info = yield* persisted(waitInput.id)
      if (!info || info.status !== "running") return { info, timedOut: false }
      if (waitInput.timeout !== undefined) {
        const elapsed = (yield* Clock.currentTimeMillis) - started
        if (elapsed >= waitInput.timeout) return { info, timedOut: true }
        yield* Effect.sleep(Math.min(DURABLE_POLL_MS, waitInput.timeout - elapsed))
        continue
      }
      yield* Effect.sleep(DURABLE_POLL_MS)
    }
  })

  const waitForPromotion: Interface["waitForPromotion"] = Effect.fn("BackgroundJob.durableWaitForPromotion")(
    function* (id) {
      while (true) {
        const info = yield* get(id)
        if (info && (info.metadata?.background === true || info.status !== "running")) return info
        yield* Effect.sleep(Math.min(1_000, heartbeatEvery))
      }
    },
  )

  const promote: Interface["promote"] = Effect.fn("BackgroundJob.durablePromote")(function* (id) {
    const owner = owners.get(id)
    if (!owner) {
      const info = yield* persisted(id)
      return info?.metadata?.background === true ? info : undefined
    }
    if (!(yield* renew(id, owner))) return undefined
    const info = yield* local.promote(id)
    if (info) yield* store.updateMetadata({ id, owner, metadata: info.metadata })
    return info
  })

  const cancel: Interface["cancel"] = Effect.fn("BackgroundJob.durableCancel")(function* (id) {
    const owner = owners.get(id)
    if (!owner) {
      const active = yield* local.get(id)
      if (active?.status === "running") yield* local.cancel(id).pipe(Effect.asVoid)
      return yield* store.abandon({ id })
    }
    if (!(yield* renew(id, owner))) return yield* persisted(id)
    const info = yield* local.cancel(id)
    const settled = info ? yield* store.settle({ id, owner, info }) : false
    if (owners.get(id) === owner) owners.delete(id)
    if (settled) return info
    return yield* persisted(id)
  })

  return Service.of({ list, get, start, extend, wait, waitForPromotion, promote, cancel })
})

export const layer = Layer.effect(Service, make)

export function durableLayer(input: { namespace: string; leaseMs?: number }) {
  return Layer.effect(Service, makeDurable(input))
}

export const defaultLayer = layer

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
