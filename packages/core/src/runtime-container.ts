export * as RuntimeContainer from "./runtime-container"

import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { RuntimeContainerControl } from "./runtime-container-control"

/** Tini forwards the container's stop signal here, not to the SDK. Keep the
 * SDK alive until the native supervisor confirms its final durable receipt. */
export async function run(
  input: {
    directory?: string
    executable?: string
    args?: readonly string[]
    env?: Readonly<Record<string, string | undefined>>
    timeoutMs?: number
    sdkStopTimeoutMs?: number
  } = {},
) {
  if (process.platform !== "linux" || process.getuid?.() !== 0)
    throw new Error("Контейнерийг зөвхөн Linux-ийн root эрхээр эхлүүлнэ.")
  const sdkStopTimeoutMs = input.sdkStopTimeoutMs ?? 15_000
  if (!Number.isSafeInteger(sdkStopTimeoutMs) || sdkStopTimeoutMs < 1 || sdkStopTimeoutMs > 30_000)
    throw new Error("Контейнер хаах хугацааны тохиргоо буруу байна.")
  const requested = Promise.withResolvers<void>()
  let stopping = false
  const stop = () => {
    stopping = true
    requested.resolve()
  }
  process.on("SIGTERM", stop)
  process.on("SIGINT", stop)
  let controller: Awaited<ReturnType<typeof RuntimeContainerControl.create>> | undefined
  let sdk: ChildProcess | undefined
  let terminal: Promise<number> | undefined
  try {
    controller = await RuntimeContainerControl.create({ directory: input.directory, timeoutMs: input.timeoutMs })
    if (stopping) return 0
    const env = { ...(input.env ?? process.env) }
    delete env.MONGOLGPT_CONTAINER_ENTRYPOINT
    sdk = spawn(input.executable ?? "/container-server/sandbox", [...(input.args ?? [])], {
      cwd: "/",
      env,
      stdio: "inherit",
    })
    terminal = new Promise<number>((resolve) => {
      sdk!.once("error", () => resolve(1))
      sdk!.once("exit", (code) => resolve(code ?? 1))
    })
    const reason = await Promise.race([
      requested.promise.then(() => "stop" as const),
      controller.failure.then(() => "failed" as const),
      terminal.then(() => "exited" as const),
    ])
    if (reason !== "stop") return 1
    const drained = await Promise.race([
      controller.drain().then((saved) => ({ saved })),
      terminal.then(() => undefined),
    ])
    if (!drained) return 1
    sdk.kill("SIGTERM")
    const code = await beforeDeadline(terminal, sdkStopTimeoutMs)
    if (code === undefined) {
      sdk.kill("SIGKILL")
      await terminal
      return 1
    }
    return drained.saved && code === 0 ? 0 : 1
  } finally {
    // A broken SDK/control channel is a fatal fence, not a successful backup.
    try {
      await controller?.close()
    } finally {
      if (sdk && sdk.exitCode === null && sdk.signalCode === null) sdk.kill("SIGKILL")
      await terminal
      process.removeListener("SIGTERM", stop)
      process.removeListener("SIGINT", stop)
    }
  }
}

async function beforeDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
