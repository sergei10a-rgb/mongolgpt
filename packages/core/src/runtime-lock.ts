export * as RuntimeLock from "./runtime-lock"

import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { constants } from "node:fs"
import type { FileHandle } from "node:fs/promises"
import { chmod, lstat, mkdir, open, realpath } from "node:fs/promises"
import { dirname, join, resolve, sep } from "node:path"

const namespace = "/run/mongolgpt-runtime-locks"
const lockTimeoutMs = 5000

export class LockError extends Error {
  constructor() {
    super("Ажлын сангийн runtime түгжээг найдвартай авах боломжгүй байна.")
    this.name = "RuntimeLockError"
  }
}

export interface Input {
  root: string
  launcher: string
  signal?: AbortSignal
}

export interface Lock {
  readonly root: string
  readonly directory: string
  close(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}

export async function acquire(input: Input): Promise<Lock> {
  if (process.platform !== "linux" || process.getuid?.() !== 0 || process.geteuid?.() !== 0) throw new LockError()
  input.signal?.throwIfAborted()
  const root = await canonicalRoot(input.root)
  const directory = directoryForRoot(root)
  const launcher = resolve(input.launcher)
  await trustedExecutable(launcher)
  await ensureLockDirectory(directory)
  const file = await openLockFile(join(directory, "lock"))
  try {
    input.signal?.throwIfAborted()
    await acquireWithLauncher({ launcher, file, signal: input.signal })
    let closed = false
    const close = async () => {
      if (closed) return
      closed = true
      await file.close()
    }
    return {
      root,
      directory,
      close,
      [Symbol.asyncDispose]: close,
    }
  } catch (error) {
    await file.close().catch(() => {})
    throw error
  }
}

async function canonicalRoot(root: string) {
  const resolved = resolve(root)
  if (root !== resolved) throw new LockError()
  const canonical = await realpath(resolved).catch(() => {
    throw new LockError()
  })
  if (canonical !== root) throw new LockError()
  const info = await lstat(canonical).catch(() => {
    throw new LockError()
  })
  if (!info.isDirectory() || info.isSymbolicLink()) throw new LockError()
  return canonical
}

async function ensureLockDirectory(directory: string) {
  await trustedRunDirectory()
  await ensureDirectory(namespace)
  await trustedLockNamespace(namespace)
  await ensureDirectory(directory)
  await trustedLockDirectory(directory)
}

async function ensureDirectory(path: string) {
  const created = await mkdir(path, { mode: 0o700 })
    .then(() => true)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") return false
      throw new LockError()
    })
  if (created) {
    await chmod(path, 0o700).catch(() => {
      throw new LockError()
    })
  }
}

async function openLockFile(path: string) {
  const opened = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    .then((file) => ({ file, created: true }))
    .catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw new LockError()
      return { file: await open(path, constants.O_RDWR | constants.O_NOFOLLOW), created: false }
    })
    .catch(() => {
      throw new LockError()
    })
  try {
    if (opened.created) await opened.file.chmod(0o600)
    const info = await opened.file.stat()
    if (!info.isFile() || info.uid !== 0 || (info.mode & 0o777) !== 0o600) throw new LockError()
    return opened.file
  } catch (error) {
    await opened.file.close().catch(() => {})
    throw error
  }
}

function directoryForRoot(root: string) {
  return join(namespace, createHash("sha256").update(root).digest("hex"))
}

async function acquireWithLauncher(input: { launcher: string; file: FileHandle; signal?: AbortSignal }) {
  const child = spawn(input.launcher, ["--lock"], {
    cwd: "/",
    env: { PATH: "/usr/bin:/bin" },
    stdio: ["ignore", "ignore", "ignore", input.file.fd],
  })
  await boundedChild(child, input.signal)
}

async function boundedChild(child: ChildProcess, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(lockTimeoutMs)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  const finished = new Promise<void>((resolve, reject) => {
    child.once("error", () => reject(new LockError()))
    child.once("close", (code) => {
      if (code === 0) return resolve()
      reject(new LockError())
    })
  })
  if (combined.aborted) {
    child.kill("SIGKILL")
    await finished.catch(() => {})
    throw signal?.aborted ? signal.reason : new LockError()
  }
  const aborted = Promise.withResolvers<never>()
  const onAbort = () => {
    child.kill("SIGKILL")
    aborted.reject(signal?.aborted ? signal.reason : new LockError())
  }
  combined.addEventListener("abort", onAbort, { once: true })
  try {
    await Promise.race([finished, aborted.promise])
  } finally {
    combined.removeEventListener("abort", onAbort)
    if (combined.aborted) await finished.catch(() => {})
  }
}

async function trustedRunDirectory() {
  if ((await realpath("/run").catch(() => "")) !== "/run") throw new LockError()
  for (let current = "/run"; ; current = dirname(current)) {
    const info = await lstat(current).catch(() => {
      throw new LockError()
    })
    if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== 0 || (info.mode & 0o022) !== 0)
      throw new LockError()
    if (current === sep) return
  }
}

async function trustedLockNamespace(path: string) {
  if ((await realpath(path).catch(() => "")) !== path) throw new LockError()
  for (let current = path; ; current = dirname(current)) {
    const info = await lstat(current).catch(() => {
      throw new LockError()
    })
    if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== 0 || (info.mode & 0o022) !== 0)
      throw new LockError()
    if (current === path && (info.mode & 0o777) !== 0o700) throw new LockError()
    if (current === sep) return
  }
}

async function trustedLockDirectory(path: string) {
  if ((await realpath(path).catch(() => "")) !== path) throw new LockError()
  for (let current = path; ; current = dirname(current)) {
    const info = await lstat(current).catch(() => {
      throw new LockError()
    })
    if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== 0) throw new LockError()
    if (current === path && (info.mode & 0o777) !== 0o700) throw new LockError()
    if (current !== path && (info.mode & 0o022) !== 0) throw new LockError()
    if (current === sep) return
  }
}

async function trustedExecutable(path: string) {
  if ((await realpath(path).catch(() => "")) !== path) throw new LockError()
  for (let current = path; ; current = dirname(current)) {
    const info = await lstat(current).catch(() => {
      throw new LockError()
    })
    const stickyAncestor = current !== path && info.isDirectory() && (info.mode & 0o1000) !== 0
    if (info.isSymbolicLink() || info.uid !== 0 || ((info.mode & 0o022) !== 0 && !stickyAncestor)) throw new LockError()
    if (current === path && (!info.isFile() || (info.mode & 0o111) === 0)) throw new LockError()
    if (current === sep) return
  }
}
