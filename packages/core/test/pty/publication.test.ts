import { expect, test } from "bun:test"
import { PtyPublication } from "@mongolgpt/core/pty/publication"

test("coalesces native data behind one publication receipt", async () => {
  const fixture = createFixture({ delayMs: 1 })
  fixture.gate.data("one")
  fixture.gate.data("two")
  await fixture.nextPublish()
  expect(fixture.output).toEqual([])
  fixture.releasePublish()
  await fixture.drain()
  expect(fixture.output).toEqual(["data:one", "data:two"])
})

test("data arriving after publish invocation waits for next snapshot", async () => {
  const fixture = createFixture()
  fixture.gate.data("first")
  const first = await fixture.nextPublish()
  fixture.gate.data("second")
  fixture.releasePublish(first)
  await fixture.drain()
  expect(fixture.output).toEqual(["data:first"])
  const second = await fixture.nextPublish()
  fixture.releasePublish(second)
  await fixture.drain()
  expect(fixture.output).toEqual(["data:first", "data:second"])
})

test("exit arriving during active publish uses a separate publication", async () => {
  const fixture = createFixture()
  fixture.gate.data("body")
  const first = await fixture.nextPublish()
  const ended = fixture.gate.end({ exitCode: 7 })
  fixture.releasePublish(first)
  await fixture.drain()
  expect(fixture.output).toEqual(["data:body"])
  expect(await settlesWithin(ended, 10)).toBe(false)
  const second = await fixture.nextPublish()
  fixture.releasePublish(second)
  await ended
  expect(fixture.output).toEqual(["data:body", "end:7"])
})

test("exit-only still requires publication", async () => {
  const fixture = createFixture()
  const ended = fixture.gate.end({ exitCode: 0 })
  const publish = await fixture.nextPublish()
  expect(fixture.output).toEqual([])
  fixture.releasePublish(publish)
  await ended
  expect(fixture.output).toEqual(["end:0"])
})

test("flushes pending data immediately when end arrives idle", async () => {
  const fixture = createFixture({ delayMs: 100 })
  fixture.gate.data("pending")
  const ended = fixture.gate.end({ exitCode: 1 })
  const publish = await fixture.nextPublish()
  fixture.releasePublish(publish)
  await ended
  expect(fixture.output).toEqual(["data:pending", "end:1"])
})

test("end returns the same result and publishes one terminal batch", async () => {
  const fixture = createFixture()
  const first = fixture.gate.end({ exitCode: 1 })
  const second = fixture.gate.end({ exitCode: 2 })
  expect(second).toBe(first)
  const publish = await fixture.nextPublish()
  fixture.releasePublish(publish)
  await first
  expect(fixture.publishes).toHaveLength(1)
  expect(fixture.output).toEqual(["end:1"])
})

test("end drains final publication before close cleanup", async () => {
  const fixture = createFixture({ delayMs: 100 })
  fixture.gate.data("final")
  const ended = fixture.gate.end({})
  const publish = await fixture.nextPublish()
  expect(await settlesWithin(ended, 10)).toBe(false)
  fixture.releasePublish(publish)
  await ended
  await fixture.gate.close()
  expect(publish.signal.aborted).toBe(false)
  expect(fixture.output).toEqual(["data:final", "end:none"])
  expect(fixture.failures).toBe(0)
})

test("ignores empty chunks without publishing or spending chunk budget", async () => {
  const fixture = createFixture()
  fixture.gate.data("")
  fixture.gate.data("")
  await fixture.drain()
  expect(fixture.publishes).toHaveLength(0)
  expect(fixture.failures).toBe(0)
})

test("enforces utf8 queued and inflight byte bounds", async () => {
  const fixture = createFixture({ maxBytes: 5 })
  fixture.gate.data("éé")
  const publish = await fixture.nextPublish()
  fixture.gate.data("x")
  expect(fixture.failures).toBe(0)
  fixture.gate.data("y")
  expect(fixture.failures).toBe(1)
  expect(publish.signal.aborted).toBe(true)
  fixture.releasePublish(publish)
  await fixture.drain()
  expect(fixture.output).toEqual([])
})

test("enforces bounded chunk count", async () => {
  const fixture = createFixture({ delayMs: 100, maxBytes: 2 * 1024 * 1024 })
  for (let index = 0; index < 4096; index++) fixture.gate.data("x")
  expect(fixture.failures).toBe(0)
  fixture.gate.data("x")
  expect(fixture.failures).toBe(1)
  await fixture.drain()
  expect(fixture.publishes).toHaveLength(0)
})

test("overflow fences exactly once and drops later data and end", async () => {
  const fixture = createFixture({ delayMs: 100, maxBytes: 3 })
  fixture.gate.data("abc")
  fixture.gate.data("d")
  fixture.gate.data("later")
  fixture.gate.end({ exitCode: 0 })
  expect(fixture.failures).toBe(1)
  await fixture.drain()
  expect(fixture.publishes).toHaveLength(0)
  expect(fixture.output).toEqual([])
})

test("publish failure fences exactly once without success end", async () => {
  const fixture = createFixture()
  fixture.gate.data("body")
  const ended = fixture.gate.end({ exitCode: 0 }).catch((error) => error)
  const publish = await fixture.nextPublish()
  fixture.rejectPublish(publish)
  await fixture.drain()
  expect(await ended).toBeInstanceOf(Error)
  expect(fixture.failures).toBe(1)
  expect(fixture.output).toEqual([])
  fixture.gate.data("later")
  fixture.gate.end({ exitCode: 1 })
  expect(fixture.failures).toBe(1)
})

test("close aborts active publish and waits for settlement cleanup", async () => {
  const fixture = createFixture()
  fixture.gate.data("body")
  const ended = fixture.gate.end({ exitCode: 0 }).catch((error) => error)
  const publish = await fixture.nextPublish()
  const closed = fixture.gate.close()
  expect(publish.signal.aborted).toBe(true)
  expect(await settlesWithin(closed, 10)).toBe(false)
  fixture.releasePublish(publish)
  await closed
  expect(await ended).toBeInstanceOf(Error)
  expect(fixture.output).toEqual([])
  expect(fixture.failures).toBe(0)
})

test("reentrant close from onData suppresses remaining callbacks", async () => {
  const fixture = createFixture({
    onData(chunk, gate) {
      fixture.output.push(`data:${chunk}`)
      if (chunk === "one") void gate.close()
    },
  })
  fixture.gate.data("one")
  fixture.gate.data("two")
  const ended = fixture.gate.end({ exitCode: 0 }).catch((error) => error)
  const publish = await fixture.nextPublish()
  fixture.releasePublish(publish)
  await fixture.drain()
  expect(await ended).toBeInstanceOf(Error)
  expect(fixture.output).toEqual(["data:one"])
  expect(fixture.failures).toBe(0)
})

test("late receipt after close is suppressed", async () => {
  const fixture = createFixture()
  fixture.gate.data("old")
  const ended = fixture.gate.end({ exitCode: 0 }).catch((error) => error)
  const publish = await fixture.nextPublish()
  const closed = fixture.gate.close()
  expect(await ended).toBeInstanceOf(Error)
  fixture.releasePublish(publish)
  await closed
  fixture.gate.data("new")
  fixture.gate.end({ exitCode: 0 })
  await fixture.drain()
  expect(fixture.output).toEqual([])
  expect(fixture.publishes).toHaveLength(1)
})

test("callback error is contained and prevents later callbacks", async () => {
  const fixture = createFixture({
    onData() {
      throw new Error("callback failed")
    },
  })
  fixture.gate.data("one")
  fixture.gate.data("two")
  const ended = fixture.gate.end({ exitCode: 0 }).catch((error) => error)
  const publish = await fixture.nextPublish()
  fixture.releasePublish(publish)
  await fixture.drain()
  expect(await ended).toBeInstanceOf(Error)
  expect(fixture.output).toEqual([])
  expect(fixture.failures).toBe(1)
})

test("callback error fences exactly once without accepting more data", async () => {
  const fixture = createFixture({
    onData() {
      throw new Error("callback failed")
    },
  })
  fixture.gate.data("one")
  const publish = await fixture.nextPublish()
  fixture.releasePublish(publish)
  await fixture.drain()
  fixture.gate.data("two")
  expect(fixture.failures).toBe(1)
  expect(fixture.publishes).toHaveLength(1)
})

test("close before publish microtask suppresses publisher invocation", async () => {
  const fixture = createFixture()
  fixture.gate.data("body")
  const closed = fixture.gate.close()
  await closed
  await fixture.drain()
  expect(fixture.publishes).toHaveLength(0)
  expect(fixture.output).toEqual([])
  expect(fixture.failures).toBe(0)
})

test("snapshots callbacks and publisher at create", async () => {
  const publishes: Publish[] = []
  const output: string[] = []
  let failures = 0
  const options = {
    delayMs: 100,
    publish(signal: AbortSignal) {
      const publish = { signal, settled: Promise.withResolvers<void>() }
      publishes.push(publish)
      return publish.settled.promise
    },
    onData(chunk: string) {
      output.push(`original:${chunk}`)
    },
    onEnd() {
      output.push("original:end")
    },
    onFailure() {
      failures++
    },
  }
  const gate = PtyPublication.create(options)
  options.publish = () => {
    throw new Error("mutated publisher")
  }
  options.onData = () => {
    throw new Error("mutated data")
  }
  options.onEnd = () => {
    throw new Error("mutated end")
  }
  options.onFailure = () => {
    failures += 100
  }
  gate.data("body")
  const ended = gate.end({})
  await waitFor(() => publishes.length === 1)
  publishes[0]?.settled.resolve()
  await ended
  expect(output).toEqual(["original:body", "original:end"])
  expect(failures).toBe(0)
})

test("reentrant data waits until current callback batch finishes", async () => {
  const fixture = createFixture({
    delayMs: 1,
    onData(chunk, gate) {
      fixture.output.push(`data:${chunk}`)
      if (chunk === "one") {
        gate.data("three")
        fixture.output.push(`publishes:${fixture.publishes.length}`)
      }
    },
  })
  fixture.gate.data("one")
  fixture.gate.data("two")
  const first = await fixture.nextPublish()
  fixture.releasePublish(first)
  await fixture.drain()
  expect(fixture.output).toEqual(["data:one", "publishes:1", "data:two"])
  const second = await fixture.nextPublish()
  fixture.releasePublish(second)
  await fixture.drain()
  expect(fixture.output).toEqual(["data:one", "publishes:1", "data:two", "data:three"])
})

function createFixture(
  options: {
    readonly delayMs?: number
    readonly maxBytes?: number
    readonly onData?: (chunk: string, gate: PtyPublication.Gate) => void
  } = {},
) {
  const publishes: Publish[] = []
  const output: string[] = []
  let failures = 0
  let observedPublishes = 0
  const publishReady = new Array<PromiseWithResolvers<Publish>>()
  let gate: PtyPublication.Gate
  gate = PtyPublication.create({
    delayMs: options.delayMs ?? 0,
    maxBytes: options.maxBytes,
    publish(signal) {
      const publish = { signal, settled: Promise.withResolvers<void>() }
      publishes.push(publish)
      const ready = publishReady.shift()
      if (ready) ready.resolve(publish)
      return publish.settled.promise
    },
    onData(chunk) {
      if (options.onData) {
        options.onData(chunk, gate)
        return
      }
      output.push(`data:${chunk}`)
    },
    onEnd(event) {
      output.push(`end:${event.exitCode ?? "none"}`)
    },
    onFailure() {
      failures++
    },
  })
  return {
    gate,
    publishes,
    output,
    get failures() {
      return failures
    },
    nextPublish() {
      const publish = publishes[observedPublishes]
      if (publish) {
        observedPublishes++
        return Promise.resolve(publish)
      }
      const ready = Promise.withResolvers<Publish>()
      publishReady.push(ready)
      return ready.promise.then((next) => {
        observedPublishes++
        return next
      })
    },
    releasePublish(publish = publishes.at(-1)) {
      if (!publish) throw new Error("missing publish")
      publish.settled.resolve()
    },
    rejectPublish(publish = publishes.at(-1)) {
      if (!publish) throw new Error("missing publish")
      publish.settled.reject(new Error("publish failed"))
    },
    drain() {
      return Promise.resolve().then(() => Promise.resolve())
    },
  }
}

type Publish = {
  readonly signal: AbortSignal
  readonly settled: PromiseWithResolvers<void>
}

async function settlesWithin<T>(promise: Promise<T>, ms: number) {
  const pending = Symbol("pending")
  return (await Promise.race([promise, Bun.sleep(ms).then(() => pending)])) !== pending
}

async function waitFor(condition: () => boolean) {
  for (let index = 0; index < 20; index++) {
    if (condition()) return
    await Bun.sleep(1)
  }
  throw new Error("condition did not settle")
}
