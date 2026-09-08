import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { setTimeout } from "node:timers/promises"
import { RuntimeSupervisor } from "@mongolgpt/core/runtime-supervisor"
import { runRuntimeSupervisor } from "../../src/cli/runtime-supervisor"

type RuntimeStart = typeof RuntimeSupervisor.start
type RuntimeHandle = Awaited<ReturnType<RuntimeStart>>
type StartInput = Parameters<RuntimeStart>[0]
type SignalName = "SIGTERM" | "SIGINT"

const signals = ["SIGTERM", "SIGINT"] as const satisfies SignalName[]
const requiredEnv = {
  MONGOLGPT_RUNTIME_MODE: "hosted",
  MONGOLGPT_CLOUD_HISTORY: "true",
  MONGOLGPT_RUNTIME_CHECKPOINT_RESTORE: "true",
  MONGOLGPT_SERVER_PASSWORD: "test-password",
} as const

describe("runRuntimeSupervisor hosted lifecycle", () => {
  test("signals during startup abort startup and remove listeners", async () => {
    await withSupervisorProcess(async () => {
      const started = deferred<StartInput>()
      const interrupted = deferred<void>()
      const start = (async (input) => {
        started.resolve(input)
        input.signal?.addEventListener("abort", () => interrupted.resolve(), { once: true })
        await interrupted.promise
        throw input.signal?.reason ?? new Error("missing abort reason")
      }) satisfies RuntimeStart

      const result = runRuntimeSupervisor({ start })
      const input = await started.promise
      process.emit("SIGTERM", "SIGTERM")

      await expect(result).rejects.toThrow("Runtime supervisor startup interrupted.")
      expect(input.signal?.aborted).toBe(true)
    })
  })

  test("runtime-ready signals wait for successful stop instead of child SIGKILL", async () => {
    await withSupervisorProcess(async () => {
      const releaseStop = deferred<void>()
      const started = deferred<StartInput>()
      const runtime = syntheticRuntime({
        stop: async () => {
          runtime.events.push("stop")
          runtime.child.signalCode = "SIGKILL"
          runtime.child.emit("exit", null, "SIGKILL")
          await releaseStop.promise
        },
      })
      const start = (async (input) => {
        started.resolve(input)
        return runtime.handle
      }) satisfies RuntimeStart

      const result = runRuntimeSupervisor({ start })
      const input = await runtimeReady(started.promise)

      expect(input).toMatchObject({
        root: "/workspace",
        launcher: "/usr/local/bin/mongolgpt-workspace-launcher",
        args: ["serve", "--hostname", "0.0.0.0", "--port", "4096"],
        env: {
          PATH: "/usr/local/bin:/usr/bin:/bin",
          HOME: "/workspace",
          XDG_DATA_HOME: "/workspace/.mongolgpt/data",
          XDG_CONFIG_HOME: "/workspace/.mongolgpt/config",
          XDG_CACHE_HOME: "/workspace/.mongolgpt/cache",
          XDG_STATE_HOME: "/workspace/.mongolgpt/state",
          MONGOLGPT_DB: "/workspace/.mongolgpt/runtime.sqlite",
        },
      })

      process.emit("SIGTERM", "SIGTERM")
      process.emit("SIGTERM", "SIGTERM")
      process.emit("SIGINT", "SIGINT")
      expect(await Promise.race([result.then(() => "done"), setTimeout(25).then(() => "pending")])).toBe("pending")

      releaseStop.resolve()
      expect(await Promise.race([result.then(() => "done"), setTimeout(25).then(() => "pending")])).toBe("pending")
      runtime.control.resolve()

      expect(await result).toBe(0)
      expect(runtime.events).toEqual(["stop"])
    })
  })

  test("runtime-ready signal returns exit 1 when final stop fails", async () => {
    await withSupervisorProcess(async () => {
      const started = deferred<StartInput>()
      const runtime = syntheticRuntime({
        stop: async () => {
          runtime.events.push("stop")
          runtime.child.signalCode = "SIGKILL"
          runtime.child.emit("exit", null, "SIGKILL")
          runtime.control.resolve()
          throw new Error("private shutdown receipt")
        },
      })
      const start = (async (input) => {
        started.resolve(input)
        return runtime.handle
      }) satisfies RuntimeStart

      const result = runRuntimeSupervisor({ start })
      await runtimeReady(started.promise)
      process.emit("SIGTERM", "SIGTERM")

      expect(await result).toBe(1)
      expect(runtime.events).toEqual(["stop"])
    })
  })

  test("unexpected child exit closes immediately without graceful stop", async () => {
    await withSupervisorProcess(async () => {
      const started = deferred<StartInput>()
      const runtime = syntheticRuntime()
      const start = (async (input) => {
        started.resolve(input)
        return runtime.handle
      }) satisfies RuntimeStart

      const result = runRuntimeSupervisor({ start })
      await runtimeReady(started.promise)
      runtime.child.exitCode = 7
      runtime.child.emit("exit", 7, null)
      // A late signal must not start a snapshot after a fatal outcome won.
      process.emit("SIGTERM", "SIGTERM")

      expect(await result).toBe(7)
      expect(runtime.events).toEqual(["group.close"])
    })
  })

  test("unexpected control failure closes immediately and throws a sanitized error", async () => {
    await withSupervisorProcess(async () => {
      const started = deferred<StartInput>()
      const runtime = syntheticRuntime()
      const start = (async (input) => {
        started.resolve(input)
        return runtime.handle
      }) satisfies RuntimeStart

      const result = runRuntimeSupervisor({ start })
      await runtimeReady(started.promise)
      runtime.control.reject(new Error("private control channel details"))

      const error = await result.catch((cause) => cause)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe("Runtime supervisor failed.")
      expect((error as Error).message).not.toContain("private control")
      expect(runtime.events).toEqual(["group.close"])
    })
  })

  test("listener cleanup also runs after an unexpected child error", async () => {
    await withSupervisorProcess(async () => {
      const started = deferred<StartInput>()
      const runtime = syntheticRuntime()
      const start = (async (input) => {
        started.resolve(input)
        return runtime.handle
      }) satisfies RuntimeStart

      const result = runRuntimeSupervisor({ start })
      await runtimeReady(started.promise)
      runtime.child.emit("error", new Error("private child error"))

      const error = await result.catch((cause) => cause)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe("Runtime supervisor failed.")
      expect(runtime.events).toEqual(["group.close"])
    })
  })
})

function syntheticRuntime(input: { stop?: (signal?: AbortSignal) => Promise<void> } = {}) {
  const child = new EventEmitter() as EventEmitter & {
    exitCode: number | null
    signalCode: string | null
  }
  const control = deferred<void>()
  const events: string[] = []
  child.exitCode = null
  child.signalCode = null
  const handle = {
    child,
    group: {
      close: async () => {
        events.push("group.close")
        control.resolve()
      },
    },
    control: control.promise,
    stop: input.stop ?? (async () => events.push("stop")),
  } as unknown as RuntimeHandle
  return { child, control, events, handle }
}

async function withSupervisorProcess(run: () => Promise<void>) {
  const previousEnv = Object.fromEntries(Object.keys(requiredEnv).map((name) => [name, process.env[name]]))
  const previousListeners = Object.fromEntries(signals.map((signal) => [signal, process.listeners(signal)]))
  Object.assign(process.env, requiredEnv)
  try {
    await run()
  } finally {
    for (const name of Object.keys(requiredEnv)) {
      const value = previousEnv[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    for (const signal of signals) {
      for (const listener of process.listeners(signal)) {
        if (!previousListeners[signal].includes(listener)) process.removeListener(signal, listener)
      }
      expect(process.listeners(signal)).toEqual(previousListeners[signal])
    }
  }
}

async function runtimeReady(started: Promise<StartInput>) {
  const input = await started
  await Promise.resolve()
  await Promise.resolve()
  return input
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}
