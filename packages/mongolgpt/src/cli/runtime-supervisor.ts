import { RuntimeSupervisor } from "@mongolgpt/core/runtime-supervisor"
import { RuntimeContainerControl } from "@mongolgpt/core/runtime-container-control"

type RuntimeStart = typeof RuntimeSupervisor.start
type RuntimeHandle = Awaited<ReturnType<RuntimeStart>>
type RuntimeSignal = "SIGTERM" | "SIGINT"
type RuntimeOutcome =
  | { type: "child-error"; error: unknown }
  | { type: "control-close" }
  | { type: "control-error"; error: unknown }
  | { type: "exit"; code: number | null; signal: string | null }
  | { type: "stop" }

const forwarded = [
  "NODE_EXTRA_CA_CERTS",
  "MONGOLGPT_SERVER_USERNAME",
  "MONGOLGPT_SERVER_PASSWORD",
  "MONGOLGPT_DISABLE_SHARE",
  "MONGOLGPT_AUTO_SHARE",
  "MONGOLGPT_RUNTIME_MODE",
  "MONGOLGPT_ENABLE_HOSTED_SERVICES",
  "MONGOLGPT_CONSOLE_URL",
  "MONGOLGPT_API_KEY",
  "MONGOLGPT_CLOUD_HISTORY",
  "MONGOLGPT_RUNTIME_CHECKPOINT_RESTORE",
] as const

export async function runRuntimeSupervisor(
  input: { start?: RuntimeStart; connect?: typeof RuntimeContainerControl.join } = {},
) {
  if (
    process.env.MONGOLGPT_RUNTIME_MODE !== "hosted" ||
    process.env.MONGOLGPT_CLOUD_HISTORY !== "true" ||
    process.env.MONGOLGPT_RUNTIME_CHECKPOINT_RESTORE !== "true" ||
    !process.env.MONGOLGPT_SERVER_PASSWORD
  )
    throw new Error("Cloud серверийн хамгаалалт эсвэл сэргээх тохиргоо дутуу байна.")
  const startRuntime = input.start ?? RuntimeSupervisor.start
  const root = "/workspace"
  const env = Object.fromEntries(
    forwarded.flatMap((name) => {
      const value = process.env[name]
      return value === undefined ? [] : [[name, value]]
    }),
  )
  const abort = new AbortController()
  let runtime: RuntimeHandle | undefined
  let connection: Awaited<ReturnType<typeof RuntimeContainerControl.join>> | undefined
  let result = 1
  let supervised = false
  const interruptStartup = () => {
    abort.abort(new Error("Runtime supervisor startup interrupted."))
    void runtime?.group.close().catch(() => {})
  }
  let interrupt = interruptStartup
  addSignalListeners(interruptStartup)
  try {
    connection = await (input.connect ?? RuntimeContainerControl.join)({
      onDrain: () => interrupt(),
      onDisconnect: () => {
        abort.abort(new Error("Container control channel closed."))
        void runtime?.group.close().catch(() => {})
      },
    })
    abort.signal.throwIfAborted()
    runtime = await startRuntime({
      root,
      launcher: "/usr/local/bin/mongolgpt-workspace-launcher",
      executable: process.execPath,
      args: ["serve", "--hostname", "0.0.0.0", "--port", "4096"],
      stdio: "inherit",
      signal: abort.signal,
      env: {
        ...env,
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: root,
        XDG_DATA_HOME: `${root}/.mongolgpt/data`,
        XDG_CONFIG_HOME: `${root}/.mongolgpt/config`,
        XDG_CACHE_HOME: `${root}/.mongolgpt/cache`,
        XDG_STATE_HOME: `${root}/.mongolgpt/state`,
        MONGOLGPT_DB: `${root}/.mongolgpt/runtime.sqlite`,
      },
    })
    abort.signal.throwIfAborted()
    removeSignalListeners(interruptStartup)
    supervised = true
    result = await superviseRuntime(runtime, (stop) => {
      interrupt = stop
    })
    return result
  } catch (error) {
    if (!supervised) {
      await runtime?.group.close().catch(() => {})
      await runtime?.control.catch(() => {})
    }
    throw error
  } finally {
    removeSignalListeners(interruptStartup)
    await connection?.complete(result === 0)
  }
}

async function superviseRuntime(runtime: RuntimeHandle, ready: (stop: () => void) => void) {
  if (runtime.child.exitCode !== null) return await closeRuntime(runtime, runtime.child.exitCode)
  if (runtime.child.signalCode !== null) return await closeRuntime(runtime, 1)

  let settled = false
  let gracefulStop: Promise<boolean> | undefined
  let resolveOutcome!: (outcome: RuntimeOutcome) => void
  const outcome = new Promise<RuntimeOutcome>((resolve) => {
    resolveOutcome = resolve
  })
  const settle = (next: RuntimeOutcome) => {
    if (settled) return
    settled = true
    resolveOutcome(next)
  }
  const stop = () => {
    if (settled) return
    if (!gracefulStop) {
      gracefulStop = Promise.resolve()
        .then(() => runtime.stop())
        .then(
          () => true,
          () => false,
        )
      settle({ type: "stop" })
    }
  }
  const exited = (code: number | null, signal: string | null) => {
    if (!gracefulStop) settle({ type: "exit", code, signal })
  }
  const childError = (error: unknown) => {
    if (!gracefulStop) settle({ type: "child-error", error })
  }
  const controlCleanup = runtime.control.then(
    () => {
      if (!gracefulStop) settle({ type: "control-close" })
    },
    (error) => {
      if (!gracefulStop) settle({ type: "control-error", error })
    },
  )

  addSignalListeners(stop)
  runtime.child.once("exit", exited)
  runtime.child.once("error", childError)
  ready(stop)
  try {
    const result = await outcome
    if (result.type === "stop") {
      const stopped = await gracefulStop!
      await controlCleanup
      return stopped ? 0 : 1
    }
    if (result.type === "exit")
      return await closeRuntime(runtime, result.code ?? (result.signal ? 1 : 0), controlCleanup)
    await closeRuntime(runtime, 1, controlCleanup)
    throw new Error("Runtime supervisor failed.")
  } finally {
    removeSignalListeners(stop)
    runtime.child.removeListener("exit", exited)
    runtime.child.removeListener("error", childError)
  }
}

async function closeRuntime(runtime: RuntimeHandle, code: number, control?: Promise<void>) {
  try {
    await runtime.group.close()
  } finally {
    await (control ?? runtime.control.catch(() => {}))
  }
  return code
}

function addSignalListeners(listener: () => void) {
  for (const signal of ["SIGTERM", "SIGINT"] satisfies RuntimeSignal[]) process.on(signal, listener)
}

function removeSignalListeners(listener: () => void) {
  for (const signal of ["SIGTERM", "SIGINT"] satisfies RuntimeSignal[]) process.removeListener(signal, listener)
}
