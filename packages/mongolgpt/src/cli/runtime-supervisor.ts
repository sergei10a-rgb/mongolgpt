import { RuntimeSupervisor } from "@mongolgpt/core/runtime-supervisor"

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

export async function runRuntimeSupervisor() {
  if (
    process.env.MONGOLGPT_RUNTIME_MODE !== "hosted" ||
    process.env.MONGOLGPT_CLOUD_HISTORY !== "true" ||
    process.env.MONGOLGPT_RUNTIME_CHECKPOINT_RESTORE !== "true" ||
    !process.env.MONGOLGPT_SERVER_PASSWORD
  )
    throw new Error("Cloud серверийн хамгаалалт эсвэл сэргээх тохиргоо дутуу байна.")
  const root = "/workspace"
  const env = Object.fromEntries(
    forwarded.flatMap((name) => {
      const value = process.env[name]
      return value === undefined ? [] : [[name, value]]
    }),
  )
  const abort = new AbortController()
  let runtime: Awaited<ReturnType<typeof RuntimeSupervisor.start>> | undefined
  const stop = () => {
    abort.abort()
    void runtime?.group.close().catch(() => {})
  }
  process.once("SIGTERM", stop)
  process.once("SIGINT", stop)
  try {
    runtime = await RuntimeSupervisor.start({
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
    const child = runtime.child
    if (child.exitCode !== null) return child.exitCode
    if (child.signalCode !== null) return 1
    return await new Promise<number>((resolve, reject) => {
      child.once("exit", (code) => resolve(code ?? 1))
      child.once("error", reject)
    })
  } finally {
    try {
      await runtime?.group.close()
      await runtime?.control
    } finally {
      process.removeListener("SIGTERM", stop)
      process.removeListener("SIGINT", stop)
    }
  }
}
