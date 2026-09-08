import { expect, test } from "bun:test"
import { Effect } from "effect"
import { Event } from "@mongolgpt/schema/event"
import { SessionEvent } from "@mongolgpt/schema/session-event"
import { createCloudHistory } from "../src/event/cloud-history"
import type { EventV2 } from "../src/event"
import type { RuntimeControl } from "../src/runtime-control"

function fixture(workspace: Pick<RuntimeControl.Client, "register" | "publish">) {
  const appended: object[] = []
  let claims = 0
  let owner: RuntimeControl.Lease | undefined
  const cloud = createCloudHistory({
    workspace,
    request: async (request) => {
      if (request.url.endsWith("/epoch")) return Response.json({ epoch: 7 })
      if (request.url.endsWith("/claim")) {
        claims++
        const body = (await request.json()) as RuntimeControl.Lease
        owner = { epoch: 8, writerID: body.writerID }
        return Response.json(owner)
      }
      if (request.url.endsWith("/append")) {
        appended.push((await request.json()) as object)
        return Response.json({ cursor: appended.length })
      }
      return Response.json({ entries: [], cursor: 0, hasMore: false })
    },
  })
  return { cloud, appended, claims: () => claims, owner: () => owner }
}

function event(type: string): EventV2.SerializedEvent {
  return { id: Event.ID.make("evt_workspace"), aggregateID: "ses_workspace", seq: 0, type, data: {} }
}

test("cloud history registers its actual claimed lease exactly once before admitting writes", async () => {
  const registered: RuntimeControl.Lease[] = []
  const ready = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const input = fixture({
    async register(lease) {
      registered.push({ ...lease })
      ready.resolve()
      await release.promise
    },
    async publish() {},
  })
  let initialized = false
  const pending = Effect.runPromise(input.cloud.initialize).then(() => {
    initialized = true
  })
  try {
    await ready.promise
    expect(registered).toEqual([input.owner()!])
    expect(initialized).toBe(false)
    const rejected = await Effect.runPromiseExit(input.cloud.append(event("session.created.1")))
    expect(rejected._tag).toBe("Failure")
    expect(input.appended).toEqual([])
  } finally {
    release.resolve()
    await pending
  }
  await Effect.runPromise(input.cloud.initialize)
  expect(input.claims()).toBe(1)
  expect(registered).toHaveLength(1)
})

for (const boundary of [
  SessionEvent.Tool.Progress,
  SessionEvent.Tool.Success,
  SessionEvent.Tool.Failed,
  SessionEvent.Step.Ended,
  SessionEvent.Step.Failed,
]) {
  test(`${boundary.type} waits for durable files before the history acknowledgement`, async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const input = fixture({
      async register() {},
      async publish() {
        entered.resolve()
        await release.promise
      },
    })
    await Effect.runPromise(input.cloud.initialize)
    const pending = Effect.runPromise(input.cloud.append(event(`${boundary.type}.${boundary.durable!.version}`)))
    try {
      await entered.promise
      expect(input.appended).toEqual([])
    } finally {
      release.resolve()
      await pending
    }
    expect(input.appended).toHaveLength(1)
    expect(input.appended[0]).toMatchObject(input.owner()!)
  })
}

test("failed file publication fences history and never acknowledges the tool or retries a new lease", async () => {
  let calls = 0
  const input = fixture({
    async register() {},
    async publish() {
      calls++
      throw new Error("server-secret")
    },
  })
  await Effect.runPromise(input.cloud.initialize)
  const failure = await Effect.runPromise(input.cloud.append(event("session.next.tool.success.1"))).catch((error) =>
    String(error),
  )
  expect(failure).toContain("Cloud")
  expect(failure).not.toContain("server-secret")
  expect((await Effect.runPromiseExit(input.cloud.append(event("session.created.1"))))._tag).toBe("Failure")
  expect((await Effect.runPromiseExit(input.cloud.initialize))._tag).toBe("Failure")
  expect(input.appended).toEqual([])
  expect(calls).toBe(1)
  expect(input.claims()).toBe(1)
})

test("non-file history events keep their existing path without taking a file snapshot", async () => {
  let captures = 0
  const input = fixture({
    async register() {},
    async publish() {
      captures++
    },
  })
  await Effect.runPromise(input.cloud.initialize)
  await Effect.runPromise(input.cloud.append(event("session.next.text.ended.1")))
  expect(input.appended).toHaveLength(1)
  expect(captures).toBe(0)
})
