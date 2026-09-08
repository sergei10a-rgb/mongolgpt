export * as PtyPublication from "./publication"

const defaultDelayMs = 25
const maxDelayMs = 100
const defaultMaxBytes = 1024 * 1024 * 2
const maxBatchChunks = 4096

export type EndEvent = {
  readonly exitCode?: number
}

export type Input = {
  readonly publish: (signal: AbortSignal) => Promise<void>
  readonly onData: (chunk: string) => void
  readonly onEnd: (event: EndEvent) => void
  readonly onFailure: () => void
  readonly delayMs?: number
  readonly maxBytes?: number
}

export type Gate = {
  readonly data: (chunk: string) => void
  readonly end: (event: EndEvent) => Promise<void>
  readonly close: () => Promise<void>
}

type Batch = {
  readonly chunks: readonly string[]
  readonly end?: EndEvent
  readonly bytes: number
}

export function create(input: Input): Gate {
  const publish = input.publish
  const onData = input.onData
  const onEnd = input.onEnd
  const onFailure = input.onFailure
  const delayMs = sanitizeDelay(input.delayMs)
  const maxBytes = sanitizeMaxBytes(input.maxBytes)
  let pendingChunks: string[] = []
  let pendingBytes = 0
  let pendingEnd: EndEvent | undefined
  let inflight: ActivePublish | undefined
  let delivering: Batch | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false
  let failed = false
  let sealed = false
  let deliveredEnd = false
  let deliveringEnd = false
  let terminal: PromiseWithResolvers<void> | undefined

  return {
    data(chunk) {
      if (closed || failed || sealed) return
      if (!admit(chunk)) return
      schedule()
    },
    end(event) {
      if (terminal) return terminal.promise
      const result = terminalResult()
      if (closed || failed || sealed) {
        rejectTerminal()
        return result
      }
      sealed = true
      pendingEnd = snapshotEnd(event)
      if (pendingBytes + (inflight?.batch.bytes ?? 0) > maxBytes) {
        fail()
        return result
      }
      schedule(true)
      return result
    },
    close() {
      closed = true
      clearFlush()
      pendingChunks = []
      pendingBytes = 0
      pendingEnd = undefined
      inflight?.abort.abort()
      if (!deliveredEnd && !deliveringEnd) rejectTerminal()
      return inflight?.settled ?? Promise.resolve()
    },
  }

  function admit(chunk: string) {
    if (chunk.length === 0) return false
    const bytes = chunk.length > maxBytes ? maxBytes + 1 : Buffer.byteLength(chunk, "utf8")
    if (
      bytes > maxBytes ||
      pendingBytes + activeBytes() + bytes > maxBytes ||
      pendingChunks.length + activeChunks() + 1 > maxBatchChunks
    ) {
      fail()
      return false
    }
    pendingChunks.push(chunk)
    pendingBytes += bytes
    return true
  }

  function schedule(immediate = false) {
    if (closed || failed || inflight || delivering) return
    if (pendingChunks.length === 0 && !pendingEnd) return
    if (timer) {
      if (!immediate) return
      clearFlush()
    }
    if (immediate || delayMs === 0) {
      flush()
      return
    }
    timer = setTimeout(() => {
      timer = undefined
      flush()
    }, delayMs)
  }

  function flush() {
    if (closed || failed || inflight) return
    if (pendingChunks.length === 0 && !pendingEnd) return
    const batch = snapshotPending()
    const abort = new AbortController()
    const active: ActivePublish = {
      abort,
      batch,
      settled: Promise.resolve()
        .then(() => {
          if (closed || failed || abort.signal.aborted || inflight !== active) return
          return publish(abort.signal)
        })
        .then(
          () => {
            if (closed || failed || abort.signal.aborted || inflight !== active) return
            inflight = undefined
            delivering = batch
            deliver(batch)
            delivering = undefined
            schedule(Boolean(pendingEnd))
          },
          () => {
            if (closed || failed || inflight !== active) return
            fail()
          },
        ),
    }
    inflight = active
  }

  function snapshotPending(): Batch {
    const batch = {
      chunks: pendingChunks.slice(),
      end: pendingEnd,
      bytes: pendingBytes,
    }
    pendingChunks = []
    pendingBytes = 0
    pendingEnd = undefined
    return batch
  }

  function deliver(batch: Batch) {
    for (const chunk of batch.chunks) {
      if (closed || failed) return
      try {
        onData(chunk)
      } catch {
        fail()
        return
      }
    }
    if (batch.end && !deliveredEnd && !closed && !failed) {
      deliveringEnd = true
      try {
        onEnd(batch.end)
      } catch {
        deliveringEnd = false
        fail()
        return
      }
      deliveringEnd = false
      deliveredEnd = true
      terminal?.resolve()
    }
  }

  function fail() {
    if (failed || closed) return
    failed = true
    clearFlush()
    pendingChunks = []
    pendingBytes = 0
    pendingEnd = undefined
    inflight?.abort.abort()
    rejectTerminal()
    try {
      onFailure()
    } catch {}
  }

  function clearFlush() {
    if (!timer) return
    clearTimeout(timer)
    timer = undefined
  }

  function terminalResult() {
    terminal = Promise.withResolvers<void>()
    terminal.promise.catch(() => {})
    return terminal.promise
  }

  function rejectTerminal() {
    if (!terminal || deliveredEnd || deliveringEnd) return
    terminal.reject(new Error("Терминалын гаралтыг баталгаажуулж дуусахаас өмнө холболт хаагдлаа."))
  }

  function activeBytes() {
    return (inflight?.batch.bytes ?? 0) + (delivering?.bytes ?? 0)
  }

  function activeChunks() {
    return (inflight?.batch.chunks.length ?? 0) + (delivering?.chunks.length ?? 0)
  }
}

type ActivePublish = {
  readonly abort: AbortController
  readonly batch: Batch
  readonly settled: Promise<void>
}

function sanitizeDelay(delayMs: number | undefined) {
  if (delayMs === undefined) return defaultDelayMs
  if (!Number.isFinite(delayMs) || delayMs < 0) return defaultDelayMs
  return Math.min(maxDelayMs, Math.trunc(delayMs))
}

function sanitizeMaxBytes(maxBytes: number | undefined) {
  if (maxBytes === undefined) return defaultMaxBytes
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) return defaultMaxBytes
  return Math.min(maxBytes, defaultMaxBytes)
}

function snapshotEnd(event: EndEvent) {
  return event.exitCode === undefined ? {} : { exitCode: event.exitCode }
}
