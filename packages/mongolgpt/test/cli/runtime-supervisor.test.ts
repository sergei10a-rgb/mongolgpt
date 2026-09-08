import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { setTimeout } from "node:timers/promises"
import { checkpointControlEnv, checkpointControlHeader } from "@mongolgpt/core/runtime-checkpoint-client"
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
  [checkpointControlEnv]: "a".repeat(64),
  MONGOLGPT_SDK_CONTROL_TOKEN: "b".repeat(64),
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

      const result = runRuntimeSupervisor({ start, connect })
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

      const result = runRuntimeSupervisor({ start, connect })
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
      expect(input.env).not.toHaveProperty(checkpointControlEnv)
      expect(input.env).not.toHaveProperty("MONGOLGPT_SDK_CONTROL_TOKEN")
      expect(input.env).not.toHaveProperty("MONGOLGPT_RUNTIME_GATEWAY_TOKEN")
      expect(input.request).toBeFunction()

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

      const result = runRuntimeSupervisor({ start, connect })
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

      const result = runRuntimeSupervisor({ start, connect })
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

      const result = runRuntimeSupervisor({ start, connect })
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

      const result = runRuntimeSupervisor({ start, connect })
      await runtimeReady(started.promise)
      runtime.child.emit("error", new Error("private child error"))

      const error = await result.catch((cause) => cause)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe("Runtime supervisor failed.")
      expect(runtime.events).toEqual(["group.close"])
    })
  })

  test("container drain uses graceful stop and waits for its completion receipt", async () => {
    await withSupervisorProcess(async () => {
      const started = deferred<StartInput>()
      const release = deferred<void>()
      const confirmed = deferred<void>()
      let drain!: () => void
      const runtime = syntheticRuntime({
        stop: async () => {
          runtime.events.push("stop")
          runtime.control.resolve()
        },
      })
      const result = runRuntimeSupervisor({
        start: async (input) => {
          started.resolve(input)
          return runtime.handle
        },
        connect: async (input) => {
          drain = input.onDrain
          return {
            complete: async (success) => {
              expect(success).toBe(true)
              confirmed.resolve()
              await release.promise
            },
          }
        },
      })
      await runtimeReady(started.promise)
      drain()
      await confirmed.promise
      expect(await Promise.race([result.then(() => "done"), setTimeout(25).then(() => "pending")])).toBe("pending")
      release.resolve()
      expect(await result).toBe(0)
      expect(runtime.events).toEqual(["stop"])
    })
  })

  test("lost container control closes the runtime immediately without a snapshot", async () => {
    await withSupervisorProcess(async () => {
      const started = deferred<StartInput>()
      let disconnect!: () => void
      const outcomes: boolean[] = []
      const runtime = syntheticRuntime()
      const result = runRuntimeSupervisor({
        start: async (input) => {
          started.resolve(input)
          return runtime.handle
        },
        connect: async (input) => {
          disconnect = input.onDisconnect
          return {
            complete: async (success) => {
              outcomes.push(success)
            },
          }
        },
      })
      await runtimeReady(started.promise)
      disconnect()
      await expect(result).rejects.toThrow("Runtime supervisor failed.")
      expect(runtime.events).not.toContain("stop")
      expect(runtime.events).toContain("group.close")
      expect(outcomes).toEqual([false])
    })
  })

  test("refused container admission never starts a runtime", async () => {
    await withSupervisorProcess(async () => {
      let starts = 0
      await expect(
        runRuntimeSupervisor({
          start: async () => {
            starts++
            return syntheticRuntime().handle
          },
          connect: async () => {
            throw new Error("Container is draining")
          },
        }),
      ).rejects.toThrow("Container is draining")
      expect(starts).toBe(0)
    })
  })

  test("missing checkpoint control token never joins IPC or starts a runtime", async () => {
    await withSupervisorProcess(async () => {
      delete process.env[checkpointControlEnv]
      let starts = 0
      let joins = 0

      await expect(
        runRuntimeSupervisor({
          start: async () => {
            starts++
            return syntheticRuntime().handle
          },
          connect: async () => {
            joins++
            return { complete: async (_success: boolean) => {} }
          },
        }),
      ).rejects.toThrow("Cloud checkpoint control token is missing or invalid.")
      expect(starts).toBe(0)
      expect(joins).toBe(0)
    })
  })

  test("passes an authenticated checkpoint request client to the runtime", async () => {
    await withSupervisorProcess(async () => {
      const started = deferred<StartInput>()
      const runtime = syntheticRuntime()
      const start = (async (input) => {
        started.resolve(input)
        return runtime.handle
      }) satisfies RuntimeStart

      const result = runRuntimeSupervisor({ start, connect, request })
      const input = await runtimeReady(started.promise)
      let forwarded!: Request

      const response = await input.request!(
        new Request("http://checkpoint.mongolgpt.internal/v1/bootstrap", { method: "POST" }),
      )
      expect(await response.text()).toBe("ok")
      expect(forwarded.headers.get(checkpointControlHeader)).toBe(requiredEnv[checkpointControlEnv])

      runtime.child.exitCode = 0
      runtime.child.emit("exit", 0, null)
      expect(await result).toBe(0)

      async function connect() {
        return { complete: async (_success: boolean) => {} }
      }
      async function request(next: Request) {
        forwarded = next
        return new Response("ok")
      }
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

async function connect() {
  return { complete: async (_success: boolean) => {} }
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
