export * as RuntimeContainerControl from "./runtime-container-control"

import { chmod, lstat, mkdir, realpath, rmdir, unlink } from "node:fs/promises"
import { createServer, connect } from "node:net"
import type { Server, Socket } from "node:net"
import { dirname, isAbsolute, resolve, sep } from "node:path"

export const directory = "/run/mongolgpt-container"

const socketName = "control.sock"
const maxFrameBytes = 64
const defaultTimeoutMs = 240_000

const frames = new Set(["register", "ready", "stop", "ok", "failed", "done"])
type Frame = "register" | "ready" | "stop" | "ok" | "failed" | "done"

export class RuntimeContainerControlError extends Error {
  constructor() {
    super("Контейнерийн runtime унтраах удирдлагын суваг алдаатай байна.")
    this.name = "RuntimeContainerControlError"
  }
}

export async function create(options: { directory?: string; timeoutMs?: number } = {}): Promise<{
  drain(): Promise<boolean>
  close(): Promise<void>
  failure: Promise<void>
}> {
  assertRoot()
  const root = resolveDirectory(options.directory ?? directory)
  const timeoutMs = validateTimeout(options.timeoutMs ?? defaultTimeoutMs)
  await createPrivateDirectory(root)
  const socketPath = resolve(root, socketName)
  const server = createServer()
  const sockets = new Set<Socket>()
  let closed = false
  let admissionClosed = false
  let active: ActiveController | undefined
  let everActive = false
  let healthyCompleted = false
  let failed = false
  let drainPromise: Promise<boolean> | undefined
  let closePromise: Promise<void> | undefined
  const failure = Promise.withResolvers<void>()
  let failureResolved = false

  const fail = () => {
    failed = true
    admissionClosed = true
    if (!failureResolved) {
      failureResolved = true
      failure.resolve()
    }
  }

  server.on("connection", (socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
    if (closed || admissionClosed || active) {
      destroySocket(socket)
      return
    }
    active = activeController(socket, {
      onRegister(controller) {
        everActive = true
        if (active === controller) {
          void controller
            .write("ready", () => timeoutMs)
            .catch(() => {
              if (active !== controller) return
              fail()
              controller.finishDrain(false)
              active = undefined
              destroySocket(controller.socket)
            })
        }
      },
      onOutcome(controller, success) {
        if (active !== controller) return
        if (controller.completing) {
          fail()
          controller.finishDrain(false)
          active = undefined
          destroySocket(controller.socket)
          return
        }
        controller.completing = true
        if (!success) fail()
        void completeActive(controller, success)
      },
      onInvalid(controller) {
        if (active !== controller) return
        if (controller.registered) fail()
        else {
          failed = true
          admissionClosed = true
        }
        controller.finishRegistration(false)
        controller.finishDrain(false)
        active = undefined
        destroySocket(controller.socket)
      },
      onUnexpectedDisconnect(controller) {
        if (active !== controller) return
        if (controller.registered) fail()
        controller.finishRegistration(false)
        controller.finishDrain(false)
        active = undefined
      },
    })
  })

  try {
    await listenUnix(server, socketPath)
    await chmod(socketPath, 0o600)
    await trustedSocket(socketPath)
  } catch (error) {
    closed = true
    await closeServer(server)
    await cleanupOwned(root, socketPath)
    throw new RuntimeContainerControlError()
  }

  return {
    failure: failure.promise,
    drain() {
      if (drainPromise) return drainPromise
      admissionClosed = true
      void unlink(socketPath).catch(() => {})
      void closeServer(server)
      drainPromise = drainActive()
      return drainPromise
    },
    close() {
      if (closePromise) return closePromise
      closed = true
      admissionClosed = true
      if (active) {
        active.finishRegistration(false)
        active.finishDrain(false)
        destroySocket(active.socket)
        active = undefined
      }
      for (const socket of sockets) destroySocket(socket)
      closePromise = closeServer(server).then(() => cleanupOwned(root, socketPath))
      return closePromise
    },
  }

  async function drainActive() {
    if (closed) return false
    if (failed) return false
    const owner = active
    if (!owner) return !everActive || healthyCompleted
    const deadline = boundedDeadline(timeoutMs, () => {
      owner.finishRegistration(false)
      owner.finishDrain(false)
      if (active === owner) {
        destroySocket(owner.socket)
        active = undefined
      }
    })
    try {
      if (!owner.registered) {
        const registered = await deadline.wait(owner.registration.promise)
        if (!registered || active !== owner || !owner.registered) {
          owner.finishDrain(false)
          destroySocket(owner.socket)
          if (active === owner) active = undefined
          return false
        }
      }
      if (owner.completing) return await deadline.wait(owner.drainResult.promise)
      await owner.write("stop", deadline.remaining)
      return await deadline.wait(owner.drainResult.promise)
    } catch {
      owner.finishDrain(false)
      destroySocket(owner.socket)
      if (active === owner) active = undefined
      return false
    } finally {
      deadline.clear()
    }
  }

  async function completeActive(controller: ActiveController, success: boolean) {
    try {
      await controller.write("done", () => timeoutMs)
      if (success) healthyCompleted = true
      if (active === controller) active = undefined
      controller.expectClose = true
      controller.finishDrain(success)
      endSocket(controller.socket)
    } catch {
      fail()
      if (active === controller) active = undefined
      controller.finishDrain(false)
      destroySocket(controller.socket)
    }
  }
}

export async function join(input: {
  directory?: string
  onDrain(): void
  onDisconnect(): void
}): Promise<{ complete(success: boolean): Promise<void> }> {
  assertRoot()
  const root = resolveDirectory(input.directory ?? directory)
  await trustedExistingDirectory(root)
  const socketPath = resolve(root, socketName)
  await trustedSocket(socketPath)
  const socket = connect(socketPath)
  let ready = false
  let drained = false
  let completing = false
  let completeDone: ReturnType<typeof Promise.withResolvers<boolean>> | undefined
  let expectedClose = false
  let doneReceived = false
  let protocolFailed = false
  let disconnected = false
  let readySettled = false
  const readyAck = Promise.withResolvers<boolean>()
  const finishReady = (success: boolean) => {
    if (readySettled) return
    readySettled = true
    readyAck.resolve(success)
  }
  const finishComplete = (success: boolean) => {
    completeDone?.resolve(success)
  }
  const invalid = () => {
    protocolFailed = true
    if (!ready) finishReady(false)
    finishComplete(false)
    notifyDisconnect()
    destroySocket(socket)
  }
  const decoder = new LineDecoder((line) => {
    const frame = parseFrame(line)
    if (!ready) {
      if (frame !== "ready") return invalid()
      ready = true
      finishReady(true)
      return
    }
    if (frame === "stop") {
      if (drained || doneReceived) return invalid()
      drained = true
      if (completing) return
      try {
        input.onDrain()
      } catch {
        destroySocket(socket)
      }
      return
    }
    if (frame === "done") {
      if (!completing || !completeDone || doneReceived) return invalid()
      doneReceived = true
      endSocket(socket)
      return
    }
    invalid()
  }, invalid)

  socket.on("data", (chunk) => decoder.push(chunk))
  socket.once("error", () => {
    if (!ready) finishReady(false)
    notifyDisconnect()
    finishComplete(false)
  })
  socket.on("error", () => {})
  socket.once("close", () => {
    if (!ready) finishReady(false)
    if (doneReceived && !protocolFailed) {
      expectedClose = true
      finishComplete(true)
      return
    }
    if (!expectedClose) notifyDisconnect()
    if (completeDone && !expectedClose) finishComplete(false)
  })

  try {
    const deadline = boundedDeadline(defaultTimeoutMs, () => {
      finishReady(false)
      destroySocket(socket)
    })
    try {
      const connecting = new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve)
        socket.once("error", reject)
      })
      connecting.catch(() => {})
      await deadline.wait(connecting)
      await writeFrame(socket, "register", deadline.remaining())
      if (!(await deadline.wait(readyAck.promise))) throw new RuntimeContainerControlError()
    } finally {
      deadline.clear()
    }
  } catch {
    destroySocket(socket)
    throw new RuntimeContainerControlError()
  }

  return {
    async complete(success: boolean) {
      if (completing || expectedClose || disconnected) throw new RuntimeContainerControlError()
      completing = true
      completeDone = Promise.withResolvers<boolean>()
      const deadline = boundedDeadline(defaultTimeoutMs, () => {
        finishComplete(false)
        notifyDisconnect()
        destroySocket(socket)
      })
      try {
        await writeFrame(socket, success ? "ok" : "failed", deadline.remaining())
        if (!(await deadline.wait(completeDone.promise))) throw new RuntimeContainerControlError()
      } catch {
        destroySocket(socket)
        throw new RuntimeContainerControlError()
      } finally {
        deadline.clear()
      }
    },
  }

  function notifyDisconnect() {
    if (!ready || expectedClose || disconnected) return
    disconnected = true
    input.onDisconnect()
  }
}

interface ActiveController {
  readonly socket: Socket
  readonly registration: ReturnType<typeof Promise.withResolvers<boolean>>
  readonly drainResult: ReturnType<typeof Promise.withResolvers<boolean>>
  registered: boolean
  completing: boolean
  expectClose: boolean
  write(frame: Frame, timeoutMs: () => number): Promise<void>
  finishRegistration(success: boolean): void
  finishDrain(success: boolean): void
}

function activeController(
  socket: Socket,
  events: {
    onRegister(controller: ActiveController): void
    onOutcome(controller: ActiveController, success: boolean): void
    onInvalid(controller: ActiveController): void
    onUnexpectedDisconnect(controller: ActiveController): void
  },
): ActiveController {
  const registration = Promise.withResolvers<boolean>()
  const drainResult = Promise.withResolvers<boolean>()
  let settledRegistration = false
  let settledDrain = false
  let writeQueue: Promise<void> = Promise.resolve()
  const controller: ActiveController = {
    socket,
    registration,
    drainResult,
    registered: false,
    completing: false,
    expectClose: false,
    write(frame, timeoutMs) {
      writeQueue = writeQueue.then(() => writeFrame(socket, frame, timeoutMs()))
      return writeQueue
    },
    finishRegistration(success) {
      if (settledRegistration) return
      settledRegistration = true
      registration.resolve(success)
    },
    finishDrain(success) {
      if (settledDrain) return
      settledDrain = true
      drainResult.resolve(success)
    },
  }
  const decoder = new LineDecoder(
    (line) => {
      const frame = parseFrame(line)
      if (!controller.registered) {
        if (frame !== "register") return events.onInvalid(controller)
        controller.registered = true
        controller.finishRegistration(true)
        events.onRegister(controller)
        return
      }
      if (controller.completing) return events.onInvalid(controller)
      if (frame === "ok") return events.onOutcome(controller, true)
      if (frame === "failed") return events.onOutcome(controller, false)
      events.onInvalid(controller)
    },
    () => events.onInvalid(controller),
  )
  socket.on("data", (chunk) => decoder.push(chunk))
  socket.once("error", () => events.onUnexpectedDisconnect(controller))
  socket.on("error", () => {})
  socket.once("close", () => {
    if (!controller.expectClose) events.onUnexpectedDisconnect(controller)
  })
  return controller
}

function parseFrame(line: string): Frame {
  if (!frames.has(line)) throw new RuntimeContainerControlError()
  return line as Frame
}

async function writeFrame(socket: Socket, frame: Frame, timeoutMs = defaultTimeoutMs) {
  if (timeoutMs < 1) throw new RuntimeContainerControlError()
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const settle = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) reject(new RuntimeContainerControlError())
      else resolve()
    }
    const timeout = setTimeout(() => settle(new RuntimeContainerControlError()), timeoutMs)
    try {
      socket.write(`${frame}\n`, (error) => {
        settle(error ?? undefined)
      })
    } catch {
      settle(new RuntimeContainerControlError())
    }
  })
}

function boundedDeadline(timeoutMs: number, expire: () => void) {
  const expiresAt = performance.now() + timeoutMs
  const timeout = setTimeout(expire, timeoutMs)
  const remaining = () => {
    const value = Math.ceil(expiresAt - performance.now())
    if (value < 1) throw new RuntimeContainerControlError()
    return value
  }
  return {
    remaining,
    async wait<T>(promise: Promise<T>) {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          const timeout = setTimeout(() => reject(new RuntimeContainerControlError()), remaining())
          promise.finally(() => clearTimeout(timeout)).catch(() => {})
        }),
      ])
    },
    clear() {
      clearTimeout(timeout)
    },
  }
}

class LineDecoder {
  private pending = Buffer.alloc(0)
  private failed = false

  constructor(
    private readonly line: (line: string) => void,
    private readonly fail: () => void,
  ) {}

  push(chunk: Buffer | string) {
    if (this.failed) return
    let data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    for (;;) {
      const index = data.indexOf(10)
      if (index === -1) {
        this.append(data)
        return
      }
      this.append(data.subarray(0, index))
      if (this.failed) return
      this.emit()
      data = data.subarray(index + 1)
    }
  }

  private append(data: Buffer) {
    if (this.pending.length + data.length > maxFrameBytes) {
      this.failed = true
      this.pending = Buffer.alloc(0)
      this.fail()
      return
    }
    if (data.length === 0) return
    this.pending = Buffer.concat([this.pending, data])
  }

  private emit() {
    if (this.failed) return
    const line = this.pending
    this.pending = Buffer.alloc(0)
    try {
      this.line(new TextDecoder("utf-8", { fatal: true }).decode(line))
    } catch {
      this.failed = true
      this.fail()
    }
  }
}

function assertRoot() {
  if (process.platform !== "linux" || process.getuid?.() !== 0 || process.geteuid?.() !== 0)
    throw new RuntimeContainerControlError()
}

function resolveDirectory(path: string) {
  if (!isAbsolute(path)) throw new RuntimeContainerControlError()
  const resolved = resolve(path)
  if (resolved !== path) throw new RuntimeContainerControlError()
  return resolved
}

function validateTimeout(timeoutMs: number) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > defaultTimeoutMs)
    throw new RuntimeContainerControlError()
  return timeoutMs
}

async function createPrivateDirectory(path: string) {
  await trustedMissingPath(path)
  await mkdir(path, { mode: 0o700 }).catch(() => {
    throw new RuntimeContainerControlError()
  })
  try {
    await chmod(path, 0o700)
    await trustedControlDirectory(path)
  } catch (error) {
    await rmdir(path).catch(() => {})
    throw error
  }
}

async function trustedMissingPath(path: string) {
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw new RuntimeContainerControlError()
  })
  if (existing) throw new RuntimeContainerControlError()
  await trustedAncestors(dirname(path))
}

async function trustedExistingDirectory(path: string) {
  if ((await realpath(path).catch(() => "")) !== path) throw new RuntimeContainerControlError()
  await trustedControlDirectory(path)
}

async function trustedControlDirectory(path: string) {
  const info = await lstat(path).catch(() => {
    throw new RuntimeContainerControlError()
  })
  if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== 0 || (info.mode & 0o777) !== 0o700)
    throw new RuntimeContainerControlError()
  await trustedAncestors(dirname(path))
}

async function trustedAncestors(path: string) {
  for (let current = path; ; current = dirname(current)) {
    const info = await lstat(current).catch(() => {
      throw new RuntimeContainerControlError()
    })
    const stickyAncestor = info.isDirectory() && (info.mode & 0o1000) !== 0
    if (
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      info.uid !== 0 ||
      ((info.mode & 0o022) !== 0 && !stickyAncestor)
    )
      throw new RuntimeContainerControlError()
    if (current === sep) return
  }
}

async function trustedSocket(path: string) {
  const info = await lstat(path).catch(() => {
    throw new RuntimeContainerControlError()
  })
  if (info.isSymbolicLink() || !info.isSocket() || info.uid !== 0 || (info.mode & 0o777) !== 0o600)
    throw new RuntimeContainerControlError()
}

async function listenUnix(server: Server, path: string) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(path, resolve)
  })
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve) => {
    try {
      server.close(() => resolve())
    } catch {
      resolve()
    }
  })
}

async function cleanupOwned(root: string, socketPath: string) {
  await unlink(socketPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw new RuntimeContainerControlError()
  })
  await rmdir(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw new RuntimeContainerControlError()
  })
}

function destroySocket(socket: Socket) {
  try {
    socket.destroy()
  } catch {}
}

function endSocket(socket: Socket) {
  try {
    socket.end()
  } catch {
    destroySocket(socket)
  }
}
