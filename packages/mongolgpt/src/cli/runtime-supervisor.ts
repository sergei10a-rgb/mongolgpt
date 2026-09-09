import { RuntimeSupervisor } from "@mongolgpt/core/runtime-supervisor"
import { RuntimeContainerControl } from "@mongolgpt/core/runtime-container-control"
import { reportStartupFailure, type NativeStartupFailure } from "./startup-diagnostic"
import { captureNativeStderr } from "./native-startup-diagnostic"
import { startupDiagnosticEnv, nativeStartupDiagnosticEnv } from "@mongolgpt/runtime-auth/startup-diagnostic"
import {
  RuntimeCheckpointClient,
  checkpointControlEnv,
  validControlToken,
} from "@mongolgpt/core/runtime-checkpoint-client"

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
  input: {
    start?: RuntimeStart
    connect?: typeof RuntimeContainerControl.join
    request?: (request: Request) => Promise<Response>
  } = {},
) {
  if (
    process.env.MONGOLGPT_RUNTIME_MODE !== "hosted" ||
    process.env.MONGOLGPT_CLOUD_HISTORY !== "true" ||
    process.env.MONGOLGPT_RUNTIME_CHECKPOINT_RESTORE !== "true" ||
    !process.env.MONGOLGPT_SERVER_PASSWORD
  )
    throw new Error("Cloud серверийн хамгаалалт эсвэл сэргээх тохиргоо дутуу байна.")
  const controlToken = process.env[checkpointControlEnv]
  if (!validControlToken(controlToken)) throw new Error("Cloud checkpoint control token is missing or invalid.")
  const startRuntime = input.start ?? RuntimeSupervisor.start
  if (
    !input.start &&
    !input.connect &&
    (process.platform !== "linux" || process.getuid?.() !== 0 || process.geteuid?.() !== 0)
  )
    throw new Error("Cloud runtime supervisor must run as Linux root.")
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
  let native: NativeStartupFailure = { phase: "native_runtime", exitCode: null }
  let collect: ReturnType<typeof captureNativeStderr> | undefined
  const diagnostic = process.env[startupDiagnosticEnv] === "true"
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
      ...(diagnostic ? { stderr: "pipe" as const } : {}),
      signal: abort.signal,
      request: RuntimeCheckpointClient.create(controlToken, input.request),
      env: {
        ...env,
        ...(diagnostic ? { [nativeStartupDiagnosticEnv]: "true" } : {}),
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: root,
        XDG_DATA_HOME: `${root}/.mongolgpt/data`,
        XDG_CONFIG_HOME: `${root}/.mongolgpt/config`,
        XDG_CACHE_HOME: `${root}/.mongolgpt/cache`,
        XDG_STATE_HOME: `${root}/.mongolgpt/state`,
        MONGOLGPT_DB: `${root}/.mongolgpt/runtime.sqlite`,
      },
    })
    if (diagnostic) collect = captureNativeStderr(runtime.child.stderr)
    abort.signal.throwIfAborted()
    removeSignalListeners(interruptStartup)
    supervised = true
    result = await superviseRuntime(
      runtime,
      (stop) => {
        interrupt = stop
      },
      (failure) => {
        native = failure
      },
    )
    if (result !== 0)
      await reportStartupFailure(undefined, controlToken, input.request, { ...native, code: await collect?.() })
    return result
  } catch (error) {
    await reportStartupFailure(
      error,
      controlToken,
      input.request,
      supervised ? { ...native, code: await collect?.() } : undefined,
    )
    if (!supervised) {
      await runtime?.group.close().catch(() => {})
      await runtime?.control.catch(() => {})
    }
    throw error
  } finally {
    removeSignalListeners(interruptStartup)
    await collect?.()
    await connection?.complete(result === 0)
  }
}

async function superviseRuntime(
  runtime: RuntimeHandle,
  ready: (stop: () => void) => void,
  failed: (failure: NativeStartupFailure) => void,
) {
  if (runtime.child.exitCode !== null) {
    failed({ phase: "native_exit", exitCode: runtime.child.exitCode || null })
    return await closeRuntime(runtime, runtime.child.exitCode)
  }
  if (runtime.child.signalCode !== null) {
    failed({ phase: "native_signal", exitCode: null })
    return await closeRuntime(runtime, 1)
  }

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
      if (!stopped) failed({ phase: "native_stop", exitCode: null })
      await controlCleanup
      return stopped ? 0 : 1
    }
    if (result.type === "exit") {
      failed({ phase: result.signal ? "native_signal" : "native_exit", exitCode: result.code || null })
      return await closeRuntime(runtime, result.code ?? (result.signal ? 1 : 0), controlCleanup)
    }
    failed({
      phase:
        result.type === "child-error"
          ? "native_child_error"
          : result.type === "control-error"
            ? "native_control_error"
            : "native_control_close",
      exitCode: null,
    })
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
