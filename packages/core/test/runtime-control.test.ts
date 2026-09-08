import { expect, test } from "bun:test"
import { createServer, connect } from "node:net"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { Duplex, PassThrough } from "node:stream"
import { RuntimeControl } from "@mongolgpt/core/runtime-control"

const lease = { epoch: 1, writerID: "writer.runtime-control" }

test.skipIf(process.platform !== "linux")(
  "inherited control survives suspension and collection of previous child handles",
  async () => {
    for (let attempt = 0; attempt < 3; attempt++) await inheritedControl()
  },
)

async function inheritedControl() {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./fixture/runtime-control-child.ts", import.meta.url))],
    {
      env: { BUN_BE_BUN: "1", PATH: process.env.PATH },
      stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
      timeout: 4000,
      killSignal: "SIGKILL",
    },
  )
  const responses = child.stdio[3] as Duplex
  const requests = child.stdio[4] as Duplex
  let stdout = ""
  let stderr = ""
  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString()
  })
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString()
  })
  const done = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", resolve)
  })
  let count = 0
  const stream = Duplex.from({ readable: requests, writable: responses })
  const server = RuntimeControl.serve(stream, {
    async publish(value) {
      expect(value).toEqual(lease)
      count++
      // Old Bun subprocess finalizers could close a newer child's reused FD.
      Bun.gc(true)
      child.kill("SIGSTOP")
      await Bun.sleep(30)
      child.kill("SIGCONT")
      await Bun.sleep(10)
    },
    async close() {
      requests.destroy()
      responses.destroy()
    },
  })
  const result = server.catch((error) => error)
  try {
    expect(await done).toBe(0)
    expect(stderr).toBe("")
    expect(stdout).toContain("CONTROL_CLOSED")
    expect(count).toBe(10)
    expect(await result).toBeUndefined()
  } finally {
    child.kill("SIGKILL")
    requests.destroy()
    responses.destroy()
    stream.destroy()
    await done.catch(() => {})
    await result
  }
}

test("client and server register then publish only after receipt", async () => {
  await using pair = await socketPair()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const server = RuntimeControl.serve(pair.server, {
    async publish(value, signal) {
      expect(value).toEqual(lease)
      expect(signal.aborted).toBe(false)
      entered.resolve()
      await release.promise
    },
    async close() {},
  })
  const client = RuntimeControl.create(pair.client)
  await client.register(lease)
  const published = client.publish()
  await entered.promise
  expect(await settlesWithin(published, 30)).toBe(false)
  release.resolve()
  await published
  client.close()
  await server
})

test("server accepts same register as idempotent and rejects lease changes", async () => {
  await using pair = await socketPair()
  let closed = false
  let registrations = 0
  const server = RuntimeControl.serve(pair.server, {
    async register() {
      registrations++
    },
    async publish() {},
    async close() {
      closed = true
    },
  })
  const serverResult = server.catch((error) => error)
  const client = RuntimeControl.create(pair.client)
  await client.register(lease)
  await client.register({ ...lease })
  expect(registrations).toBe(1)
  expect(await client.register({ epoch: 2, writerID: lease.writerID }).catch((error) => error)).toBeInstanceOf(
    RuntimeControl.RuntimeControlError,
  )
  expect(await serverResult).toBeInstanceOf(RuntimeControl.RuntimeControlError)
  expect(closed).toBe(true)
})

test("registration is acknowledged only after durable root state is written", async () => {
  await using pair = await socketPair()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const server = RuntimeControl.serve(pair.server, {
    async register(value, signal) {
      expect(value).toEqual(lease)
      expect(signal.aborted).toBe(false)
      entered.resolve()
      await release.promise
    },
    async publish() {},
    async close() {},
  })
  const client = RuntimeControl.create(pair.client)
  try {
    const registering = client.register(lease)
    await entered.promise
    expect(await settlesWithin(registering, 30)).toBe(false)
    release.resolve()
    await registering
  } finally {
    release.resolve()
    client.close()
    await server
  }
})

test("failed durable registration closes the root and never admits publication", async () => {
  await using pair = await socketPair()
  let closed = false
  let published = false
  const server = RuntimeControl.serve(pair.server, {
    async register() {
      throw new Error("private state write failed")
    },
    async publish() {
      published = true
    },
    async close() {
      closed = true
    },
  }).catch((error) => error)
  const client = RuntimeControl.create(pair.client)
  await expect(client.register(lease)).rejects.toBeInstanceOf(RuntimeControl.RuntimeControlError)
  expect(await server).toBeInstanceOf(RuntimeControl.RuntimeControlError)
  expect(closed).toBe(true)
  expect(published).toBe(false)
})

test("server rejects publish before register without ack", async () => {
  await using pair = await socketPair()
  let published = false
  const server = RuntimeControl.serve(pair.server, {
    async publish() {
      published = true
    },
    async close() {},
  })
  const serverResult = server.catch((error) => error)
  const client = RuntimeControl.create(pair.client)
  expect(await client.publish().catch((error) => error)).toBeInstanceOf(RuntimeControl.RuntimeControlError)
  expect(await serverResult).toBeInstanceOf(RuntimeControl.RuntimeControlError)
  expect(published).toBe(false)
})

test("fragmented frames decode over a real socket", async () => {
  await using pair = await socketPair()
  const seen: string[] = []
  const server = RuntimeControl.serve(pair.server, {
    async publish(value) {
      seen.push(value.writerID)
    },
    async close() {},
  })
  const read = socketReader(pair.client)
  pair.client.write('{"id":1,"op":"reg')
  pair.client.write('ister","lease":{"epoch":1,"writerID":"writer.runtime-control"}}\n')
  expect(await read()).toBe('{"id":1,"ok":true}')
  pair.client.write('{"id":2,"op":"publish"}\n')
  expect(await read()).toBe('{"id":2,"ok":true}')
  pair.client.destroy()
  await server
  expect(seen).toEqual([lease.writerID])
})

test("server fails closed on oversized, unknown-field, and non-sequential frames", async () => {
  for (const frame of [
    `${" ".repeat(4097)}\n`,
    '{"id":1,"op":"register","lease":{"epoch":1,"writerID":"writer.runtime-control"},"root":"/tmp"}\n',
    '{"id":2,"op":"register","lease":{"epoch":1,"writerID":"writer.runtime-control"}}\n',
  ]) {
    await using pair = await socketPair()
    let closed = false
    const server = RuntimeControl.serve(pair.server, {
      async publish() {},
      async close() {
        closed = true
      },
    })
    const serverResult = server.catch((error) => error)
    pair.client.write(frame)
    expect(await serverResult).toBeInstanceOf(RuntimeControl.RuntimeControlError)
    expect(closed).toBe(true)
  }
})

test("server rejects malformed lease before publish", async () => {
  await using pair = await socketPair()
  let published = false
  const server = RuntimeControl.serve(pair.server, {
    async publish() {
      published = true
    },
    async close() {},
  })
  const serverResult = server.catch((error) => error)
  pair.client.write('{"id":1,"op":"register","lease":{"epoch":1,"writerID":"bad writer"}}\n')
  expect(await serverResult).toBeInstanceOf(RuntimeControl.RuntimeControlError)
  expect(published).toBe(false)
})

test("publish failure closes root before destroying channel and sends no ack", async () => {
  await using pair = await socketPair()
  const events: string[] = []
  const server = RuntimeControl.serve(pair.server, {
    async publish() {
      events.push("publish")
      throw new Error("private failure")
    },
    async close() {
      events.push("close")
      expect(pair.server.destroyed).toBe(false)
    },
  })
  const serverResult = server.catch((error) => error)
  const client = RuntimeControl.create(pair.client)
  await client.register(lease)
  expect(await client.publish().catch((error) => error)).toBeInstanceOf(RuntimeControl.RuntimeControlError)
  expect(await serverResult).toBeInstanceOf(RuntimeControl.RuntimeControlError)
  expect(events).toEqual(["publish", "close"])
})

test("socket close aborts active publish and awaits cleanup", async () => {
  await using pair = await socketPair()
  const entered = Promise.withResolvers<void>()
  const releaseCleanup = Promise.withResolvers<void>()
  let aborted = false
  let cleanupDone = false
  const server = RuntimeControl.serve(pair.server, {
    async publish(_lease, signal) {
      signal.addEventListener("abort", () => {
        aborted = true
        entered.resolve()
      })
      await new Promise(() => {})
    },
    async close() {
      await releaseCleanup.promise
      cleanupDone = true
    },
  })
  const client = RuntimeControl.create(pair.client)
  await client.register(lease)
  const published = client.publish().catch((error) => error)
  await settlesWithin(published, 30)
  pair.client.destroy()
  await entered.promise
  expect(await settlesWithin(server, 30)).toBe(false)
  releaseCleanup.resolve()
  await server
  expect(aborted).toBe(true)
  expect(cleanupDone).toBe(true)
})

test("client pre-abort destroys channel without sending a request", async () => {
  await using pair = await socketPair()
  let closed = false
  const server = RuntimeControl.serve(pair.server, {
    async publish() {},
    async close() {
      closed = true
    },
  })
  const client = RuntimeControl.create(pair.client)
  expect(await client.register(lease, AbortSignal.abort()).catch((error) => error)).toBeInstanceOf(
    RuntimeControl.RuntimeControlError,
  )
  await server
  expect(closed).toBe(true)
})

test("queued request abort fences the channel before it can be sent", async () => {
  await using pair = await socketPair()
  const abort = new AbortController()
  const entered = Promise.withResolvers<AbortSignal>()
  const activeAborted = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const server = RuntimeControl.serve(pair.server, {
    async publish(_lease, signal) {
      signal.addEventListener("abort", () => activeAborted.resolve(), { once: true })
      entered.resolve(signal)
      await release.promise
    },
    async close() {},
  })
  const client = RuntimeControl.create(pair.client)
  await client.register(lease)
  const active = client.publish().catch((error) => error)
  const signal = await entered.promise
  const queued = client.publish(abort.signal).catch((error) => error)
  abort.abort()
  await activeAborted.promise
  expect(signal.aborted).toBe(true)
  release.resolve()
  expect(await active).toBeInstanceOf(RuntimeControl.RuntimeControlError)
  expect(await queued).toBeInstanceOf(RuntimeControl.RuntimeControlError)
  await server
})

test("client pending overflow fails closed", async () => {
  await using pair = await socketPair()
  const release = Promise.withResolvers<void>()
  let closed = false
  const server = RuntimeControl.serve(pair.server, {
    async publish(_lease, signal) {
      if (signal.aborted) return
      await release.promise
    },
    async close() {
      closed = true
    },
  })
  const client = RuntimeControl.create(pair.client)
  await client.register(lease)
  const pending = Array.from({ length: 64 }, () => client.publish().catch((error) => error))
  expect(await client.publish().catch((error) => error)).toBeInstanceOf(RuntimeControl.RuntimeControlError)
  expect(pair.client.destroyed).toBe(true)
  release.resolve()
  expect((await Promise.all(pending)).every((error) => error instanceof RuntimeControl.RuntimeControlError)).toBe(true)
  await server
  expect(closed).toBe(true)
})

test("client rejects stale acknowledgements after cancellation fences the channel", async () => {
  await using pair = await socketPair()
  const abort = new AbortController()
  const client = RuntimeControl.create(pair.client)
  const pending = client.register(lease, abort.signal).catch((error) => error)
  abort.abort()
  expect(await pending).toBeInstanceOf(RuntimeControl.RuntimeControlError)
  pair.server.write('{"id":1,"ok":true}\n')
  expect(await client.publish().catch((error) => error)).toBeInstanceOf(RuntimeControl.RuntimeControlError)
})

test("client active timeout rejects and destroys channel", async () => {
  await using pair = await socketPair()
  const client = RuntimeControl.create(pair.client, { timeoutMs: 20 })
  const pending = client.register(lease).catch((error) => error)
  const error = await pending
  expect(error).toBeInstanceOf(RuntimeControl.RuntimeControlError)
  expect(error.message).toContain("хугацаа")
  expect(pair.client.destroyed).toBe(true)
})

test("client cannot disable or extend the request deadline", async () => {
  await using pair = await socketPair()
  for (const timeoutMs of [0, -1, 0.5, Number.NaN, Infinity, 120_001]) {
    expect(() => RuntimeControl.create(pair.client, { timeoutMs })).toThrow(RuntimeControl.RuntimeControlError)
  }
})

test("serve rejects when root cleanup fails on socket close", async () => {
  await using pair = await socketPair()
  const server = RuntimeControl.serve(pair.server, {
    async publish() {},
    async close() {
      throw new Error("private cleanup failure")
    },
  }).catch((error) => error)
  pair.client.destroy()
  expect(await server).toBeInstanceOf(RuntimeControl.RuntimeControlError)
})

test("server does not ack publish that resolves after channel close", async () => {
  await using pair = await socketPair()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let publishAcks = 0
  const write = pair.server.write.bind(pair.server)
  pair.server.write = ((chunk: string | Uint8Array, ...args: never[]) => {
    if (chunk.toString().includes('"id":2')) publishAcks++
    return write(chunk, ...args)
  }) as typeof pair.server.write
  const server = RuntimeControl.serve(pair.server, {
    async publish() {
      entered.resolve()
      await release.promise
    },
    async close() {},
  })
  const read = socketReader(pair.client)
  pair.client.write('{"id":1,"op":"register","lease":{"epoch":1,"writerID":"writer.runtime-control"}}\n')
  expect(await read()).toBe('{"id":1,"ok":true}')
  pair.client.write('{"id":2,"op":"publish"}\n')
  await entered.promise
  pair.client.destroy()
  await Bun.sleep(10)
  release.resolve()
  await server
  expect(publishAcks).toBe(0)
})

test("stream end disconnects client immediately before close", async () => {
  await using pair = streamPair()
  const client = RuntimeControl.create(pair.child)
  const pending = client.register(lease).catch((error) => error)
  pair.rootToChild.end()
  expect(await pending).toBeInstanceOf(RuntimeControl.RuntimeControlError)
  expect(pair.child.writableEnded).toBe(true)
})

test("stream end aborts server publish, awaits cleanup, and sends no late ack", async () => {
  await using pair = streamPair()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const cleanup = Promise.withResolvers<void>()
  let aborted = false
  let publishAcks = 0
  const write = pair.root.write.bind(pair.root)
  pair.root.write = ((chunk: string | Uint8Array, ...args: never[]) => {
    if (chunk.toString().includes('"id":2')) publishAcks++
    return write(chunk, ...args)
  }) as typeof pair.root.write
  const server = RuntimeControl.serve(pair.root, {
    async publish(_lease, signal) {
      signal.addEventListener("abort", () => {
        aborted = true
        entered.resolve()
      })
      await release.promise
    },
    async close() {
      await cleanup.promise
    },
  })
  const read = socketReader(pair.child)
  pair.child.write('{"id":1,"op":"register","lease":{"epoch":1,"writerID":"writer.runtime-control"}}\n')
  expect(await read()).toBe('{"id":1,"ok":true}')
  pair.child.write('{"id":2,"op":"publish"}\n')
  pair.childToRoot.end()
  await entered.promise
  expect(await settlesWithin(server, 30)).toBe(false)
  release.resolve()
  await Bun.sleep(10)
  const channelClosed = new Promise<void>((resolve) => pair.root.once("close", resolve))
  cleanup.resolve()
  await server
  await channelClosed
  expect(aborted).toBe(true)
  expect(publishAcks).toBe(0)
  expect(pair.root.destroyed).toBe(true)
})

async function socketPair() {
  const sockets = Promise.withResolvers<{ client: Duplex; server: Duplex }>()
  const listener = createServer((server) => sockets.resolve({ client, server }))
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve))
  const address = listener.address()
  if (!address || typeof address === "string") throw new Error("missing listener address")
  const client = connect(address.port, "127.0.0.1")
  await new Promise<void>((resolve) => client.once("connect", resolve))
  const pair = await sockets.promise
  return {
    ...pair,
    async [Symbol.asyncDispose]() {
      pair.client.destroy()
      pair.server.destroy()
      await new Promise<void>((resolve) => listener.close(() => resolve()))
    },
  }
}

function streamPair() {
  const childToRoot = new PassThrough()
  const rootToChild = new PassThrough()
  const root = Duplex.from({ readable: childToRoot, writable: rootToChild })
  const child = Duplex.from({ readable: rootToChild, writable: childToRoot })
  return {
    child,
    root,
    childToRoot,
    rootToChild,
    async [Symbol.asyncDispose]() {
      child.destroy()
      root.destroy()
      childToRoot.destroy()
      rootToChild.destroy()
    },
  }
}

function socketReader(stream: Duplex) {
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
          reject(new Error("stream closed"))
        }
        const cleanup = () => {
          stream.off("data", data)
          stream.off("error", error)
          stream.off("close", close)
        }
        stream.once("data", data)
        stream.once("error", error)
        stream.once("close", close)
      })
    }
  }
}

async function settlesWithin<T>(promise: Promise<T>, ms: number) {
  const pending = Symbol("pending")
  return (await Promise.race([promise, Bun.sleep(ms).then(() => pending)])) !== pending
}
