export * as RuntimeControl from "./runtime-control"

import { Duplex } from "node:stream"
import { Schema } from "effect"

const maxFrameBytes = 4096
const maxPending = 64
const requestTimeoutMs = 120_000
const Integer = Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const WriterID = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.:-]{1,256}$/))
export const Lease = Schema.Struct({ epoch: Integer, writerID: WriterID })
export type Lease = typeof Lease.Type

const RegisterRequest = Schema.Struct({ id: Integer, op: Schema.Literal("register"), lease: Lease })
const PublishRequest = Schema.Struct({ id: Integer, op: Schema.Literal("publish") })
const RequestFrame = Schema.Union([RegisterRequest, PublishRequest])
const ResponseFrame = Schema.Struct({ id: Integer, ok: Schema.Literal(true) })
type RequestFrame = typeof RequestFrame.Type
type ResponseFrame = typeof ResponseFrame.Type

export interface Client {
  register(lease: Lease, signal?: AbortSignal): Promise<void>
  publish(signal?: AbortSignal): Promise<void>
  close(): void
}

export class RuntimeControlError extends Error {
  constructor(message = "Runtime удирдлагын суваг хаагдлаа.") {
    super(message)
    this.name = "RuntimeControlError"
  }
}

export function create(stream: Duplex, options: { timeoutMs?: number } = {}): Client {
  const timeoutMs = options.timeoutMs ?? requestTimeoutMs
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > requestTimeoutMs) throw new RuntimeControlError()
  let nextID = 1
  let closed = false
  let active: ClientCall | undefined
  const queue: ClientCall[] = []
  const decoder = new LineDecoder(
    (line) => settleActiveResponse(line),
    () => closeClient(new RuntimeControlError()),
  )

  stream.on("data", (chunk) => decoder.push(chunk))
  stream.once("error", () => closeClient(new RuntimeControlError()))
  stream.on("error", () => {})
  stream.once("end", () => closeClient(new RuntimeControlError(), false))
  stream.once("close", () => closeClient(new RuntimeControlError()))

  return {
    register(lease, signal) {
      const snapshot = snapshotLease(lease)
      return enqueue((id) => ({ id, op: "register", lease: snapshot }), signal)
    },
    publish(signal) {
      return enqueue((id) => ({ id, op: "publish" }), signal)
    },
    close() {
      closeClient(new RuntimeControlError("Runtime удирдлагын суваг хаагдсан."))
    },
  }

  function enqueue(frame: (id: number) => RequestFrame, signal?: AbortSignal) {
    if (closed) return Promise.reject(new RuntimeControlError())
    if ((active ? 1 : 0) + queue.length >= maxPending) {
      const error = new RuntimeControlError("Runtime удирдлагын хүлээгдэж буй хүсэлт хэтэрлээ.")
      closeClient(error)
      return Promise.reject(error)
    }
    if (signal?.aborted) {
      const error = new RuntimeControlError("Runtime удирдлагын хүсэлт цуцлагдлаа.")
      closeClient(error)
      return Promise.reject(error)
    }
    const call = clientCall(frame(nextID++), signal, closeClient, timeoutMs)
    call.watch()
    queue.push(call)
    drainClient()
    return call.promise
  }

  function drainClient() {
    if (closed || active || queue.length === 0) return
    active = queue.shift()
    if (!active) return
    active.start()
    writeFrame(stream, active.frame).catch((error) => {
      active?.reject(error)
      closeClient(error)
    })
  }

  function settleActiveResponse(line: string) {
    if (!active) return closeClient(new RuntimeControlError())
    const response = decodeCanonical(line, ResponseFrame, canonicalResponse)
    if (response.id !== active.frame.id) return closeClient(new RuntimeControlError())
    active.resolve()
    active = undefined
    drainClient()
  }

  function closeClient(error: RuntimeControlError, destroy = true) {
    if (closed) return
    closed = true
    active?.reject(error)
    active = undefined
    for (const call of queue.splice(0)) call.reject(error)
    if (destroy) {
      destroyStream(stream)
      return
    }
    endStream(stream)
  }
}

export function serve(
  stream: Duplex,
  input: { publish(lease: Lease, signal: AbortSignal): Promise<unknown>; close(): Promise<void> },
): Promise<void> {
  return new Promise((resolve, reject) => {
    let closed = false
    let expectedID = 1
    let lease: Lease | undefined
    let activeAbort: AbortController | undefined
    let handling = false
    let cleanup: Promise<void> | undefined
    const queue: string[] = []
    const decoder = new LineDecoder(
      (line) => {
        if ((handling ? 1 : 0) + queue.length >= maxPending) {
          void failClosed(new RuntimeControlError())
          return
        }
        queue.push(line)
        drainServer()
      },
      () => void failClosed(new RuntimeControlError()),
    )

    stream.on("data", (chunk) => decoder.push(chunk))
    stream.once("error", () => void stopRoot())
    stream.on("error", () => {})
    stream.once("end", () => void stopRoot())
    stream.once("close", () => void stopRoot())

    function drainServer() {
      if (closed || handling || queue.length === 0) return
      const line = queue.shift()
      if (!line) return
      handling = true
      void handle(line)
    }

    async function handle(line: string) {
      try {
        const request = decodeCanonical(line, RequestFrame, canonicalRequest)
        if (request.id !== expectedID++) throw new RuntimeControlError()
        if (request.op === "register") {
          if (lease && !sameLease(lease, request.lease)) throw new RuntimeControlError()
          lease = request.lease
          await writeFrame(stream, { id: request.id, ok: true })
          handling = false
          drainServer()
          return
        }
        if (!lease) throw new RuntimeControlError()
        activeAbort = new AbortController()
        const signal = activeAbort.signal
        await input.publish(lease, signal)
        if (closed || signal.aborted) return
        activeAbort = undefined
        await writeFrame(stream, { id: request.id, ok: true })
        handling = false
        drainServer()
      } catch {
        await failClosed(new RuntimeControlError())
      }
    }

    async function stopRoot() {
      if (closed) return cleanup
      closed = true
      handling = false
      queue.length = 0
      activeAbort?.abort()
      stream.pause()
      cleanup = input.close().then(
        () => resolve(),
        () => reject(new RuntimeControlError()),
      )
      await cleanup
    }

    async function failClosed(error: RuntimeControlError) {
      if (closed) return cleanup
      closed = true
      handling = false
      queue.length = 0
      activeAbort?.abort()
      stream.pause()
      cleanup = input.close().then(
        () => {
          destroyStream(stream)
          reject(error)
        },
        () => {
          destroyStream(stream)
          reject(new RuntimeControlError())
        },
      )
      await cleanup
    }
  })
}

function destroyStream(stream: Duplex) {
  try {
    stream.destroy()
  } catch {}
}

function endStream(stream: Duplex) {
  try {
    stream.end()
  } catch {}
}

function clientCall(
  frame: RequestFrame,
  signal: AbortSignal | undefined,
  close: (error: RuntimeControlError) => void,
  timeoutMs: number,
) {
  const pending = Promise.withResolvers<void>()
  let settled = false
  let timeout: ReturnType<typeof setTimeout> | undefined
  const cancel = () => {
    reject(new RuntimeControlError("Runtime удирдлагын хүсэлт цуцлагдлаа."))
    close(new RuntimeControlError("Runtime удирдлагын хүсэлт цуцлагдлаа."))
  }
  return {
    frame,
    promise: pending.promise,
    watch() {
      signal?.addEventListener("abort", cancel, { once: true })
    },
    start() {
      timeout = setTimeout(() => {
        reject(new RuntimeControlError("Runtime удирдлагын хүсэлт хугацаа хэтэрлээ."))
        close(new RuntimeControlError("Runtime удирдлагын хүсэлт хугацаа хэтэрлээ."))
      }, timeoutMs)
    },
    resolve() {
      if (settled) return
      settled = true
      if (timeout) clearTimeout(timeout)
      signal?.removeEventListener("abort", cancel)
      pending.resolve()
    },
    reject(error: RuntimeControlError) {
      reject(error)
    },
  }

  function reject(error: RuntimeControlError) {
    if (settled) return
    settled = true
    if (timeout) clearTimeout(timeout)
    signal?.removeEventListener("abort", cancel)
    pending.reject(error)
  }
}

type ClientCall = ReturnType<typeof clientCall>

function snapshotLease(lease: Lease) {
  return Schema.decodeUnknownSync(Lease)({ ...lease }, { onExcessProperty: "error" })
}

function sameLease(left: Lease, right: Lease) {
  return left.epoch === right.epoch && left.writerID === right.writerID
}

function decodeCanonical<A>(line: string, schema: Schema.Decoder<A>, canonical: (value: A) => string) {
  try {
    const decoded = Schema.decodeUnknownSync(schema)(Schema.decodeUnknownSync(Schema.UnknownFromJsonString)(line), {
      onExcessProperty: "error",
    })
    if (canonical(decoded) !== line) throw new RuntimeControlError()
    return decoded
  } catch {
    throw new RuntimeControlError()
  }
}

async function writeFrame(stream: Duplex, frame: RequestFrame | ResponseFrame) {
  const line = "op" in frame ? canonicalRequest(frame) : canonicalResponse(frame)
  if (Buffer.byteLength(line) > maxFrameBytes) throw new RuntimeControlError()
  await new Promise<void>((resolve, reject) => {
    try {
      stream.write(`${line}\n`, (error) => {
        if (error) reject(new RuntimeControlError())
        else resolve()
      })
    } catch {
      reject(new RuntimeControlError())
    }
  })
}

function canonicalRequest(frame: RequestFrame) {
  if (frame.op === "register")
    return JSON.stringify({
      id: frame.id,
      op: "register",
      lease: { epoch: frame.lease.epoch, writerID: frame.lease.writerID },
    })
  return JSON.stringify({ id: frame.id, op: "publish" })
}

function canonicalResponse(frame: ResponseFrame) {
  return JSON.stringify({ id: frame.id, ok: true })
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
