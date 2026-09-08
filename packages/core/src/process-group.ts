export * as ProcessGroup from "./process-group"

import { spawn } from "node:child_process"
import type { ChildProcess, SpawnOptions } from "node:child_process"
import { constants } from "node:fs"
import { chmod, lstat, mkdir, open, readFile, realpath, rmdir, statfs, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve, sep } from "node:path"
import { randomUUID } from "node:crypto"
import { setTimeout } from "node:timers/promises"

export class IsolationError extends Error {
  constructor() {
    super("Ажлын процессуудыг найдвартай тусгаарлаж эсвэл түр зогсоож чадсангүй.")
    this.name = "WorkspaceIsolationError"
  }
}

export interface Input {
  launcher: string
  uid: number
  gid: number
  root?: string
}

export interface Command {
  executable: string
  args: readonly string[]
  cwd: string
  env: Readonly<Record<string, string>>
  stdio?: "pipe" | "ignore" | "inherit"
  startupFD?: number
  controlChannel?: boolean
}

/** Only a root-owned runtime record may select this group. The caller must hold
 * the kernel workspace lock, so no live supervisor can admit more descendants. */
export async function reap(directory: string) {
  if (
    process.platform !== "linux" ||
    process.getuid?.() !== 0 ||
    process.geteuid?.() !== 0 ||
    !/^\/sys\/fs\/cgroup\/mongolgpt-[0-9a-f-]{36}$/.test(directory)
  )
    throw new IsolationError()
  const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!info) return
  await trustedPath(directory, true)
  if ((await statfs(directory)).type !== 0x63677270) throw new IsolationError()
  const file = await open(join(directory, "cgroup.kill"), constants.O_WRONLY | constants.O_NOFOLLOW)
  try {
    await file.writeFile("1")
  } finally {
    await file.close()
  }
  await waitFor(join(directory, "cgroup.events"), "populated", "0", 5000)
  await rmdir(directory)
}

/** Linux hosted-supervisor boundary. The supervisor and SDK must stay outside
 * this group; every workspace writer must be launched inside it. This does not
 * replace durable publication or make an unsupervised existing process safe. */
export async function create(input: Input) {
  const uid = input.uid
  const gid = input.gid
  if (process.platform !== "linux" || process.getuid?.() !== 0 || process.geteuid?.() !== 0) throw new IsolationError()
  if (![uid, gid].every((value) => Number.isInteger(value) && value >= 10000 && value <= 60000))
    throw new IsolationError()
  const root = resolve(input.root ?? "/sys/fs/cgroup")
  const launcher = resolve(input.launcher)
  if (root !== "/sys/fs/cgroup" && !root.startsWith("/sys/fs/cgroup/")) throw new IsolationError()
  await trustedPath(root, true)
  await trustedPath(launcher, false)
  if ((await statfs(root)).type !== 0x63677270) throw new IsolationError()
  const directory = join(root, `mongolgpt-${randomUUID()}`)
  await mkdir(directory, { mode: 0o700 })
  const freeze = join(directory, "cgroup.freeze")
  const events = join(directory, "cgroup.events")
  const kill = join(directory, "cgroup.kill")
  let stopped = false
  let poisoned = false
  let pending: Promise<unknown> = Promise.resolve()
  let closing: Promise<void> | undefined
  const lifetime = new AbortController()
  const children = new Map<ChildProcess, Promise<void>>()
  try {
    await chmod(directory, 0o700)
    // Refuse unsupported kernels before starting any workspace process.
    await readFile(freeze, "utf8")
    await readFile(events, "utf8")
    const probe = await open(kill, constants.O_WRONLY | constants.O_NOFOLLOW)
    await probe.close()
  } catch {
    await rmdir(directory)
    throw new IsolationError()
  }

  function serialized<A>(run: () => Promise<A>) {
    const operation = pending.then(run)
    pending = operation.catch(() => {})
    return operation
  }

  function available() {
    if (stopped || poisoned) throw new IsolationError()
  }

  function close() {
    if (closing) return closing
    if (stopped) return Promise.resolve()
    poisoned = true
    lifetime.abort(new IsolationError())
    closing = (async () => {
      // cgroup.kill includes detached descendants, not just the original PID.
      // Kill now, even if capture is awaiting IO. Keep the group until that
      // callback settles; never thaw or abandon its native cleanup early.
      await writeFile(kill, "1")
      // Terminal listeners were registered at spawn, before either kill can
      // finish a launcher. Bound this wait independently of capture settlement.
      const launchers = [...children]
      const timeout = new AbortController()
      try {
        for (const [child] of launchers) child.kill("SIGKILL")
        await Promise.race([
          Promise.all(launchers.map(([, terminal]) => terminal)),
          setTimeout(5000, undefined, { signal: timeout.signal }).then(() => {
            throw new IsolationError()
          }),
        ])
      } finally {
        timeout.abort()
      }
      return serialized(async () => {
        // A launcher could join and fork after the first sweep. No launcher
        // can admit more descendants now; kill those late arrivals as well.
        await writeFile(kill, "1")
        await waitFor(events, "populated", "0", 5000)
        await rmdir(directory)
        stopped = true
      })
    })()
    return closing
  }

  return {
    // Diagnostic identity only, never a caller-selected process group.
    directory,
    spawn(command: Command) {
      if (stopped || poisoned) return Promise.reject(new IsolationError())
      const executable = command.executable
      const args = [...command.args]
      const env = { ...command.env }
      const cwd = command.cwd
      const stdio = command.stdio ?? "pipe"
      const startupFD = command.startupFD
      const controlChannel = command.controlChannel === true
      return serialized(async () => {
        available()
        if (!isAbsolute(executable) || !isAbsolute(cwd)) throw new IsolationError()
        if (startupFD !== undefined && (!Number.isInteger(startupFD) || startupFD < 0)) throw new IsolationError()
        // Defense in depth if a different launcher build is dynamically linked.
        if (Object.keys(env).some((key) => /^(LD_|DYLD_)/.test(key))) throw new IsolationError()
        const file = await open(join(directory, "cgroup.procs"), constants.O_WRONLY | constants.O_NOFOLLOW)
        try {
          available()
          const options: SpawnOptions = {
            cwd: "/",
            env,
            detached: true,
            stdio: [
              stdio,
              stdio,
              stdio,
              file.fd,
              startupFD ?? "ignore",
              ...(controlChannel ? ["pipe" as const, "pipe" as const] : []),
            ],
          }
          const child = spawn(launcher, [String(uid), String(gid), cwd, executable, ...args], options)
          const terminal = Promise.withResolvers<void>()
          children.set(child, terminal.promise)
          const finished = () => {
            children.delete(child)
            child.removeListener("exit", finished)
            child.removeListener("error", finished)
            terminal.resolve()
          }
          child.once("exit", finished)
          child.once("error", finished)
          await new Promise<void>((accept, reject) => {
            child.once("spawn", accept)
            child.once("error", () => {
              reject(new IsolationError())
            })
          })
          return child
        } finally {
          await file.close()
        }
      })
    },
    // timeoutMs bounds freezer transitions. Native work must honor signal and
    // settle its own cleanup; it must never be abandoned while still capturing.
    quiesce<A>(
      run: (signal: AbortSignal) => Promise<A>,
      options: { signal?: AbortSignal; timeoutMs?: number; closeOnError?: boolean } = {},
    ) {
      if (stopped || poisoned) return Promise.reject(new IsolationError())
      const signal = options.signal ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal
      const timeoutMs = options.timeoutMs ?? 5000
      const closeOnError = options.closeOnError === true
      const operation = serialized(async () => {
        available()
        if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new IsolationError()
        signal?.throwIfAborted()
        try {
          await writeFile(freeze, "1")
          await waitFor(events, "frozen", "1", timeoutMs, signal)
          // Do not race cancellation against run: thaw only after native capture
          // and publication have actually settled, including their cleanup.
          signal?.throwIfAborted()
          const result = await run(signal)
          signal.throwIfAborted()
          return result
        } catch (error) {
          if (closeOnError) {
            // Do not resume writers after an uncertain durable receipt. Fence
            // queued work now; close outside this serialized operation below.
            poisoned = true
            lifetime.abort(new IsolationError())
          }
          throw error
        } finally {
          if (!poisoned) {
            try {
              await writeFile(freeze, "0")
              await waitFor(events, "frozen", "0", timeoutMs)
            } catch {
              poisoned = true
              throw new IsolationError()
            }
          }
        }
      })
      if (!closeOnError) return operation
      return operation.catch(async (error) => {
        await close()
        throw error
      })
    },
    close,
  }
}

async function waitFor(path: string, key: string, expected: string, timeoutMs: number, signal?: AbortSignal) {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    signal?.throwIfAborted()
    const entries = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => line.split(/\s+/))
    const value = entries.find(([name]) => name === key)?.[1]
    if (value === expected) return
    if (value !== "0" && value !== "1") throw new IsolationError()
    if (performance.now() >= deadline) throw new IsolationError()
    await setTimeout(10, undefined, { signal })
  }
}

async function trustedPath(path: string, directory: boolean) {
  if ((await realpath(path)) !== path) throw new IsolationError()
  for (let current = path; ; current = dirname(current)) {
    const info = await lstat(current)
    const stickyAncestor = current !== path && info.isDirectory() && (info.mode & 0o1000) !== 0
    if (info.isSymbolicLink() || info.uid !== 0 || ((info.mode & 0o022) !== 0 && !stickyAncestor))
      throw new IsolationError()
    if (current === path && (directory ? !info.isDirectory() : !info.isFile() || (info.mode & 0o111) === 0))
      throw new IsolationError()
    if (current === sep) return
  }
}
