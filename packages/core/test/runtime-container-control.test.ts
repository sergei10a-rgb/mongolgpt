import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { connect, createServer } from "node:net"
import type { Socket } from "node:net"
import { chmod, copyFile, lstat, mkdir, realpath, rmdir, symlink, unlink } from "node:fs/promises"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { RuntimeContainerControl } from "@mongolgpt/core/runtime-container-control"

const isolated = process.platform === "linux" && process.getuid?.() === 0 && process.geteuid?.() === 0

describe.skipIf(!isolated)("root-only container shutdown control", () => {
  test("creates a private directory and 0600 unix socket", async () => {
    const path = await controlPath()
    const control = await RuntimeContainerControl.create({ directory: path })
    try {
      const directory = await lstat(path)
      const socket = await lstat(join(path, "control.sock"))
      expect(directory.uid).toBe(0)
      expect(directory.mode & 0o777).toBe(0o700)
      expect(socket.uid).toBe(0)
      expect(socket.mode & 0o777).toBe(0o600)
      expect(socket.isSocket()).toBe(true)
    } finally {
      await control.close()
    }
    await expect(lstat(path)).rejects.toThrow()
  })

  test("private socket rejects unprivileged direct connect", async () => {
    const path = await controlPath()
    const control = await RuntimeContainerControl.create({ directory: path })
    await using bun = await publicBun()
    try {
      const result = await unprivilegedConnect(bun.path, join(path, "control.sock"))
      expect(result).toMatchObject({ code: 0, stdout: "EACCES\n" })
      expect(await control.drain()).toBe(true)
    } finally {
      await control.close()
    }
  })

  test("refuses existing directory and symlink path", async () => {
    const existing = await controlPath()
    const link = await controlPath()
    try {
      await mkdir(existing, { mode: 0o700 })
      await chmod(existing, 0o700)
      await expect(RuntimeContainerControl.create({ directory: existing })).rejects.toBeInstanceOf(
        RuntimeContainerControl.RuntimeContainerControlError,
      )
      await symlink(existing, link)
      await expect(RuntimeContainerControl.create({ directory: link })).rejects.toBeInstanceOf(
        RuntimeContainerControl.RuntimeContainerControlError,
      )
    } finally {
      await unlink(link).catch(() => {})
      await rmdir(existing).catch(() => {})
    }
  })

  test("refuses an unsafe non-sticky writable ancestor", async () => {
    const parent = await controlPath()
    await mkdir(parent, { mode: 0o777 })
    await chmod(parent, 0o777)
    try {
      await expect(RuntimeContainerControl.create({ directory: join(parent, "control") })).rejects.toBeInstanceOf(
        RuntimeContainerControl.RuntimeContainerControlError,
      )
    } finally {
      await rmdir(parent)
    }
  })

  test("join waits for ready and drain invokes onDrain exactly once", async () => {
    const path = await controlPath()
    const control = await RuntimeContainerControl.create({ directory: path })
    let drains = 0
    const worker = await RuntimeContainerControl.join({
      directory: path,
      onDrain() {
        drains++
      },
      onDisconnect() {
        throw new Error("unexpected disconnect")
      },
    })
    const drained = control.drain()
    await waitUntil(() => drains === 1)
    await worker.complete(true)
    expect(await drained).toBe(true)
    expect(drains).toBe(1)
    await control.close()
  })

  test("drain succeeds when no runtime ever registered", async () => {
    const path = await controlPath()
    const control = await RuntimeContainerControl.create({ directory: path })
    expect(await control.drain()).toBe(true)
    await control.close()
  })

  test("healthy complete before drain releases admission for native resume", async () => {
    const path = await controlPath()
    const control = await RuntimeContainerControl.create({ directory: path })
    const first = await RuntimeContainerControl.join({
      directory: path,
      onDrain() {
        throw new Error("first should complete before drain")
      },
      onDisconnect() {
        throw new Error("first disconnect should be expected")
      },
    })
    await first.complete(true)
    let drained = false
    const second = await RuntimeContainerControl.join({
      directory: path,
      onDrain() {
        drained = true
      },
      onDisconnect() {
        throw new Error("second disconnect should be expected")
      },
    })
    const drain = control.drain()
    await waitUntil(() => drained)
    await second.complete(true)
    expect(await drain).toBe(true)
    await control.close()
  })

  test("late admissions are rejected once drain starts", async () => {
    const path = await controlPath()
    const control = await RuntimeContainerControl.create({ directory: path })
    expect(await control.drain()).toBe(true)
    await expect(
      RuntimeContainerControl.join({
        directory: path,
        onDrain() {},
        onDisconnect() {},
      }),
    ).rejects.toBeInstanceOf(RuntimeContainerControl.RuntimeContainerControlError)
    await control.close()
  })

  test("failed completion resolves failure and makes drain false", async () => {
    const path = await controlPath()
    const control = await RuntimeContainerControl.create({ directory: path })
    const worker = await RuntimeContainerControl.join({
      directory: path,
      onDrain() {},
      onDisconnect() {
        throw new Error("failed completion should be expected")
      },
    })
    const failure = control.failure.then(() => "failed")
    await worker.complete(false)
    expect(await failure).toBe("failed")
    expect(await control.drain()).toBe(false)
    await control.close()
  })

  test("later failed runtime is not hidden by prior healthy complete", async () => {
    const path = await controlPath()
    const control = await RuntimeContainerControl.create({ directory: path })
    const first = await RuntimeContainerControl.join({
      directory: path,
      onDrain() {},
      onDisconnect() {},
    })
    await first.complete(true)
    const second = await RuntimeContainerControl.join({
      directory: path,
      onDrain() {},
      onDisconnect() {},
    })
    const failure = control.failure.then(() => "failed")
    await second.complete(false)
    expect(await failure).toBe("failed")
    expect(await control.drain()).toBe(false)
    await control.close()
  })

  test("drain returns false on timeout and fences future admission", async () => {
    const path = await controlPath()
    const control = await RuntimeContainerControl.create({ directory: path, timeoutMs: 20 })
    let disconnected = false
    await RuntimeContainerControl.join({
      directory: path,
      onDrain() {},
      onDisconnect() {
        disconnected = true
      },
    })
    expect(await control.drain()).toBe(false)
    await waitUntil(() => disconnected)
    await expect(
      RuntimeContainerControl.join({
        directory: path,
        onDrain() {},
        onDisconnect() {},
      }),
    ).rejects.toBeInstanceOf(RuntimeContainerControl.RuntimeContainerControlError)
    await control.close()
  })

  test("unexpected registered disconnect resolves failure and makes drain false", async () => {
    const path = await controlPath()
    const control = await RuntimeContainerControl.create({ directory: path })
    const socket = await rawClient(path)
    socket.write("register\n")
    expect(await socketReader(socket)()).toBe("ready")
    const failure = control.failure.then(() => "disconnected")
    const drain = control.drain()
    expect(await socketReader(socket)()).toBe("stop")
    socket.destroy()
    expect(await failure).toBe("disconnected")
    expect(await drain).toBe(false)
    await control.close()
  })

  test("malformed, duplicate, and oversized frames fail closed", async () => {
    for (const frame of ["bad\n", "register\nregister\n", `${"x".repeat(65)}\n`]) {
      const path = await controlPath()
      const control = await RuntimeContainerControl.create({ directory: path })
      const socket = await rawClient(path)
      const failure = control.failure.then(() => "failed")
      socket.write(frame)
      if (frame.startsWith("register\n")) expect(await failure).toBe("failed")
      else await socketClosed(socket)
      expect(await control.drain()).toBe(false)
      socket.destroy()
      await control.close()
    }
  })

  test("fragmented reads accept only canonical ordered frames", async () => {
    const path = await controlPath()
    const control = await RuntimeContainerControl.create({ directory: path })
    const socket = await rawClient(path)
    const read = socketReader(socket)
    socket.write("reg")
    socket.write("ister\n")
    expect(await read()).toBe("ready")
    const drain = control.drain()
    expect(await read()).toBe("stop")
    socket.write("o")
    socket.write("k\n")
    expect(await read()).toBe("done")
    expect(await drain).toBe(true)
    socket.destroy()
    await control.close()
  })

  test("drain success requires done acknowledgement to be flushed", async () => {
    const path = await controlPath()
    const control = await RuntimeContainerControl.create({ directory: path })
    const socket = await rawClient(path)
    const read = socketReader(socket)
    socket.write("register\n")
    expect(await read()).toBe("ready")
    const drain = control.drain()
    expect(await read()).toBe("stop")
    socket.write("ok\n")
    expect(await drain).toBe(true)
    expect(await read()).toBe("done")
    socket.destroy()
    await control.close()
  })

  test("duplicate terminal outcome after ok fences the controller", async () => {
    const path = await controlPath()
    const control = await RuntimeContainerControl.create({ directory: path })
    const socket = await rawClient(path)
    const read = socketReader(socket)
    socket.write("register\n")
    expect(await read()).toBe("ready")
    const failure = control.failure.then(() => "failed")
    const drain = control.drain()
    expect(await read()).toBe("stop")
    socket.write("ok\nfailed\n")
    expect(await failure).toBe("failed")
    expect(await drain).toBe(false)
    await socketClosed(socket)
    await expect(
      RuntimeContainerControl.join({
        directory: path,
        onDrain() {},
        onDisconnect() {},
      }),
    ).rejects.toBeInstanceOf(RuntimeContainerControl.RuntimeContainerControlError)
    await control.close()
  })

  test("drain waits for pending register fragment and preserves ack order", async () => {
    const path = await controlPath()
    const control = await RuntimeContainerControl.create({ directory: path, timeoutMs: 200 })
    const socket = await rawClient(path)
    const read = socketReader(socket)
    socket.write("reg")
    const drain = control.drain()
    expect(await settlesWithin(drain, 30)).toBe(false)
    socket.write("ister\n")
    expect(await read()).toBe("ready")
    expect(await read()).toBe("stop")
    socket.write("ok\n")
    expect(await read()).toBe("done")
    expect(await drain).toBe(true)
    socket.destroy()
    await control.close()
  })

  test("drain returns false for incomplete register fragment", async () => {
    const path = await controlPath()
    const control = await RuntimeContainerControl.create({ directory: path, timeoutMs: 20 })
    const socket = await rawClient(path)
    socket.write("reg")
    const closed = socketClosed(socket)
    expect(await control.drain()).toBe(false)
    await closed
    await control.close()
  })

  test("complete waits for done receipt before closing", async () => {
    const path = await controlPath()
    const control = await RuntimeContainerControl.create({ directory: path })
    let disconnected = false
    const worker = await RuntimeContainerControl.join({
      directory: path,
      onDrain() {},
      onDisconnect() {
        disconnected = true
      },
    })
    await worker.complete(true)
    expect(disconnected).toBe(false)
    expect(await control.drain()).toBe(true)
    await control.close()
  })

  test("join rejects trailing frames after done", async () => {
    await using server = await protocolServer((socket) => {
      const read = socketReader(socket)
      void (async () => {
        expect(await read()).toBe("register")
        socket.write("ready\n")
        expect(await read()).toBe("ok")
        socket.write("done\ndone\n")
      })()
    })
    let disconnected = false
    const worker = await RuntimeContainerControl.join({
      directory: server.path,
      onDrain() {
        throw new Error("trailing done should not drain")
      },
      onDisconnect() {
        disconnected = true
      },
    })
    await expect(worker.complete(true)).rejects.toBeInstanceOf(RuntimeContainerControl.RuntimeContainerControlError)
    expect(disconnected).toBe(true)
  })

  test("join accepts stop racing with in-progress complete", async () => {
    await using server = await protocolServer((socket) => {
      const read = socketReader(socket)
      void (async () => {
        expect(await read()).toBe("register")
        socket.write("ready\n")
        expect(await read()).toBe("ok")
        socket.write("stop\ndone\n")
      })()
    })
    let drains = 0
    let disconnected = false
    const worker = await RuntimeContainerControl.join({
      directory: server.path,
      onDrain() {
        drains++
      },
      onDisconnect() {
        disconnected = true
      },
    })
    await worker.complete(true)
    expect(drains).toBe(0)
    expect(disconnected).toBe(false)
  })

  test("timeout validation is bounded", async () => {
    for (const timeoutMs of [0, -1, 0.5, Number.NaN, Infinity, 240_001]) {
      await expect(
        RuntimeContainerControl.create({ directory: await controlPath(), timeoutMs }),
      ).rejects.toBeInstanceOf(RuntimeContainerControl.RuntimeContainerControlError)
    }
  })
})

test("create and join are Linux root only", async () => {
  if (isolated) return
  await expect(RuntimeContainerControl.create({ directory: "/tmp/mongolgpt-not-root-test" })).rejects.toBeInstanceOf(
    RuntimeContainerControl.RuntimeContainerControlError,
  )
  await expect(
    RuntimeContainerControl.join({
      directory: "/tmp/mongolgpt-not-root-test",
      onDrain() {},
      onDisconnect() {},
    }),
  ).rejects.toBeInstanceOf(RuntimeContainerControl.RuntimeContainerControlError)
})

async function controlPath() {
  return join(await realpath("/tmp"), `mongolgpt-container-${randomUUID()}`)
}

async function rawClient(path: string) {
  const socket = connect(join(path, "control.sock"))
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve)
    socket.once("error", reject)
  })
  return socket
}

async function publicBun() {
  const path = await controlPath()
  await mkdir(path, { mode: 0o555 })
  await chmod(path, 0o555)
  const binary = join(path, "bun")
  await copyFile(process.execPath, binary)
  await chmod(binary, 0o555)
  return {
    path: binary,
    async [Symbol.asyncDispose]() {
      await unlink(binary).catch(() => {})
      await rmdir(path).catch(() => {})
    },
  }
}

async function unprivilegedConnect(executable: string, socketPath: string) {
  const script = `
    import { connect } from "node:net"
    const socket = connect(process.argv[process.argv.length - 1])
    const timeout = setTimeout(() => {
      console.log("TIMEOUT")
      socket.destroy()
      process.exit(1)
    }, 2000)
    socket.once("connect", () => {
      clearTimeout(timeout)
      console.log("CONNECTED")
      socket.destroy()
      process.exit(1)
    })
    socket.once("error", (error) => {
      clearTimeout(timeout)
      console.log(error?.code ?? "UNKNOWN")
      process.exit(error?.code === "EACCES" ? 0 : 1)
    })
  `
  const child = spawn(executable, ["--eval", script, socketPath], {
    cwd: "/",
    env: { PATH: "/usr/bin:/bin" },
    gid: 10001,
    uid: 10001,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5000,
    killSignal: "SIGKILL",
  })
  let stdout = ""
  let stderr = ""
  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString()
  })
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString()
  })
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", resolve)
  })
  return { code, stdout, stderr }
}

async function protocolServer(handle: (socket: Socket) => void) {
  const path = await controlPath()
  await mkdir(path, { mode: 0o700 })
  await chmod(path, 0o700)
  const socketPath = join(path, "control.sock")
  const server = createServer(handle)
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(socketPath, resolve)
  })
  await chmod(socketPath, 0o600)
  return {
    path,
    async [Symbol.asyncDispose]() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await unlink(socketPath).catch(() => {})
      await rmdir(path).catch(() => {})
    },
  }
}

function socketReader(socket: ReturnType<typeof connect>) {
  let buffered = ""
  return async function readLine() {
    for (;;) {
      const index = buffered.indexOf("\n")
      if (index !== -1) {
        const line = buffered.slice(0, index)
        buffered = buffered.slice(index + 1)
        return line
      }
      buffered += await new Promise<string>((resolve, reject) => {
        const data = (chunk: Buffer) => {
          cleanup()
          resolve(chunk.toString("utf8"))
        }
        const error = (reason: Error) => {
          cleanup()
          reject(reason)
        }
        const close = () => {
          cleanup()
          reject(new Error("socket closed"))
        }
        const cleanup = () => {
          socket.off("data", data)
          socket.off("error", error)
          socket.off("close", close)
        }
        socket.once("data", data)
        socket.once("error", error)
        socket.once("close", close)
      })
    }
  }
}

async function socketClosed(socket: ReturnType<typeof connect>) {
  if (socket.closed || socket.destroyed) return
  await new Promise<void>((resolve) => socket.once("close", resolve))
}

async function settlesWithin<T>(promise: Promise<T>, ms: number) {
  const pending = Symbol("pending")
  return (await Promise.race([promise, Bun.sleep(ms).then(() => pending)])) !== pending
}

async function waitUntil(predicate: () => boolean | Promise<boolean>) {
  const deadline = performance.now() + 2000
  while (!(await predicate())) {
    if (performance.now() >= deadline) throw new Error("condition was not reached")
    await Bun.sleep(10)
  }
}
