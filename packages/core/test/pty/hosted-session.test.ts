import { expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Queue } from "effect"
import { Config } from "@mongolgpt/core/config"
import { EventV2 } from "@mongolgpt/core/event"
import { Location } from "@mongolgpt/core/location"
import { Pty } from "@mongolgpt/core/pty"
import { AbsolutePath } from "@mongolgpt/core/schema"
import { location } from "../fixture/location"

type Receipt = ReturnType<typeof Promise.withResolvers<void>> & { signal: AbortSignal }
const native = process.platform === "win32" ? test.skip : test

function scenario(
  body: (input: { calls: Queue.Queue<Receipt>; failures: number[] }) => Effect.Effect<void, unknown, Pty.Service>,
  cleanup?: () => Promise<void>,
) {
  return Effect.gen(function* () {
    const calls = yield* Queue.unbounded<Receipt>()
    const failures: number[] = []
    const layer = Pty.layerWithPublication({
      publish(signal) {
        const receipt = { ...Promise.withResolvers<void>(), signal }
        const abort = () => receipt.reject(new Error("publication aborted"))
        signal.addEventListener("abort", abort, { once: true })
        Queue.offerUnsafe(calls, receipt)
        return receipt.promise.finally(async () => {
          signal.removeEventListener("abort", abort)
          if (signal.aborted) await cleanup?.()
        })
      },
      fence: () => {
        failures.push(1)
      },
    }).pipe(
      Layer.provide(Layer.mock(Config.Service)({ entries: () => Effect.succeed([]) })),
      Layer.provide(EventV2.defaultLayer),
      Layer.provide(
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make("/tmp") }))),
      ),
    )
    yield* body({ calls, failures }).pipe(Effect.provide(layer))
  }).pipe(Effect.scoped, Effect.timeout("10 seconds"), Effect.runPromise)
}

const next = (calls: Queue.Queue<Receipt>) => Queue.take(calls).pipe(Effect.timeout("5 seconds"))

native("hosted PTY withholds live output, replay and cursor until publication", () =>
  scenario(({ calls, failures }) =>
    Effect.gen(function* () {
      const pty = yield* Pty.Service
      const info = yield* pty.create({ command: "cat", cwd: "/tmp" })
      const output: string[] = []
      const delivered = yield* Deferred.make<void>()
      const attached = yield* pty.attach(info.id, {
        onData: (chunk) => {
          output.push(chunk)
          Deferred.doneUnsafe(delivered, Effect.void)
        },
        onEnd() {},
      })
      attached.activate()
      yield* pty.write(info.id, "MGPT_HELD\n")
      const receipt = yield* next(calls)
      expect(output).toEqual([])
      const waiting = yield* pty.attach(info.id, { onData() {}, onEnd() {} })
      expect(waiting.replay).toBe("")
      expect(waiting.cursor).toBe(0)
      expect((yield* pty.get(info.id)).status).toBe("running")
      receipt.resolve()
      yield* Deferred.await(delivered)
      expect(output.join("")).toContain("MGPT_HELD")
      const replay = yield* pty.attach(info.id, { onData() {}, onEnd() {} })
      expect(replay.replay).toContain("MGPT_HELD")
      expect(replay.cursor).toBeGreaterThan(0)
      expect(failures).toEqual([])
    }),
  ),
)

native("hosted PTY withholds successful exit status until a terminal receipt", () =>
  scenario(({ calls }) =>
    Effect.gen(function* () {
      const pty = yield* Pty.Service
      const info = yield* pty.create({ command: "/bin/sh", args: ["-c", "read value; exit 7"], cwd: "/tmp" })
      const ended = yield* Deferred.make<{ exitCode?: number }>()
      const attached = yield* pty.attach(info.id, {
        onData() {},
        onEnd: (event) => Deferred.doneUnsafe(ended, Effect.succeed(event)),
      })
      attached.activate()
      yield* pty.write(info.id, "exit\n")
      const receipt = yield* next(calls)
      expect((yield* pty.get(info.id)).status).toBe("running")
      expect((yield* pty.get(info.id)).exitCode).toBeUndefined()
      expect(yield* Deferred.isDone(ended)).toBe(false)
      // Native output and exit can be separate batches. Release every actual
      // receipt until the end callback, rather than assuming OS callback order.
      receipt.resolve()
      const drain = yield* Effect.forkChild(Effect.forever(next(calls).pipe(Effect.map((call) => call.resolve()))))
      expect(yield* Deferred.await(ended)).toEqual({ exitCode: 7 })
      yield* Fiber.interrupt(drain)
      expect((yield* pty.get(info.id)).status).toBe("exited")
      expect((yield* pty.get(info.id)).exitCode).toBe(7)
    }),
  ),
)

native("lost PTY publication fences all terminals without output or success", () =>
  scenario(({ calls, failures }) =>
    Effect.gen(function* () {
      const pty = yield* Pty.Service
      const first = yield* pty.create({ command: "cat", cwd: "/tmp" })
      const second = yield* pty.create({ command: "cat", cwd: "/tmp" })
      const output: string[] = []
      const ends: Array<{ exitCode?: number }> = []
      const closed = yield* Deferred.make<void>()
      for (const info of [first, second]) {
        const attached = yield* pty.attach(info.id, {
          onData: (chunk) => output.push(chunk),
          onEnd: (event) => {
            ends.push(event)
            if (ends.length === 2) Deferred.doneUnsafe(closed, Effect.void)
          },
        })
        attached.activate()
      }
      yield* pty.write(first.id, "MGPT_UNKNOWN\n")
      const receipt = yield* next(calls)
      receipt.reject(new Error("lost durable receipt"))
      yield* Deferred.await(closed)
      expect(output).toEqual([])
      expect(ends).toEqual([{}, {}])
      expect(failures).toEqual([1])
      expect(yield* pty.list()).toEqual([])
      expect((yield* pty.create({ command: "cat", cwd: "/tmp" }).pipe(Effect.exit))._tag).toBe("Failure")
    }),
  ),
)

native("removing a hosted terminal waits for its final publication without fencing", () =>
  scenario(({ calls, failures }) =>
    Effect.gen(function* () {
      const pty = yield* Pty.Service
      const info = yield* pty.create({ command: "cat", cwd: "/tmp" })
      const removed = yield* Deferred.make<void>()
      const removing = yield* Effect.forkChild(
        pty.remove(info.id).pipe(Effect.tap(() => Deferred.succeed(removed, undefined))),
      )
      const receipt = yield* next(calls)
      expect(yield* Deferred.isDone(removed)).toBe(false)
      expect(receipt.signal.aborted).toBe(false)
      receipt.resolve()
      yield* Fiber.join(removing)
      expect(yield* Deferred.isDone(removed)).toBe(true)
      expect(failures).toEqual([])
      expect(yield* pty.list()).toEqual([])
    }),
  ),
)

native("graceful hosted removal drains retained native output before end delivery", () =>
  scenario(({ calls, failures }) =>
    Effect.gen(function* () {
      const pty = yield* Pty.Service
      const info = yield* pty.create({ command: "cat", cwd: "/tmp" })
      const output: string[] = []
      const ends: Array<{ exitCode?: number }> = []
      const attached = yield* pty.attach(info.id, {
        onData: (chunk) => output.push(chunk),
        onEnd: (event) => ends.push(event),
      })
      attached.activate()
      yield* pty.write(info.id, "FINAL_OUTPUT\n")
      const first = yield* next(calls)
      const removing = yield* Effect.forkChild(pty.remove(info.id))
      yield* Effect.yieldNow
      expect(output).toEqual([])
      expect(ends).toEqual([])
      first.resolve()
      const final = yield* next(calls)
      expect(output.join("")).toContain("FINAL_OUTPUT")
      expect(ends).toEqual([])
      final.resolve()
      yield* Fiber.join(removing)
      expect(ends).toEqual([{}])
      expect(failures).toEqual([])
    }),
  ),
)

native("hosted PTY scope teardown waits for publication cancellation cleanup", async () => {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const output: string[] = []
  let finished = false
  const running = scenario(
    ({ calls }) =>
      Effect.gen(function* () {
        const pty = yield* Pty.Service
        const info = yield* pty.create({ command: "cat", cwd: "/tmp" })
        const attached = yield* pty.attach(info.id, { onData: (chunk) => output.push(chunk), onEnd() {} })
        attached.activate()
        yield* pty.write(info.id, "CANCELLED_OUTPUT\n")
        yield* next(calls)
      }),
    async () => {
      entered.resolve()
      await release.promise
    },
  ).then(() => {
    finished = true
  })
  try {
    await entered.promise
    expect(finished).toBe(false)
    expect(output).toEqual([])
  } finally {
    release.resolve()
    await running
  }
  expect(finished).toBe(true)
  expect(output).toEqual([])
})

native("gracefully removed hosted terminals do not consume exited retention", () =>
  scenario(({ calls, failures }) =>
    Effect.gen(function* () {
      const pty = yield* Pty.Service
      const drain = yield* Effect.forkChild(Effect.forever(next(calls).pipe(Effect.map((call) => call.resolve()))))
      for (let index = 0; index < 27; index++) {
        const info = yield* pty.create({ command: "cat", cwd: "/tmp" })
        yield* pty.remove(info.id)
      }
      const info = yield* pty.create({ command: "/bin/sh", args: ["-c", "exit 3"], cwd: "/tmp" })
      const deadline = performance.now() + 5000
      while ((yield* pty.get(info.id)).status !== "exited") {
        expect(performance.now()).toBeLessThan(deadline)
        yield* Effect.sleep("10 millis")
      }
      expect((yield* pty.list()).map((entry) => entry.id)).toEqual([info.id])
      expect(failures).toEqual([])
      yield* Fiber.interrupt(drain)
    }),
  ),
)
