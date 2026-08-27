import { expect, test } from "bun:test"
import { createLocalBridgeCallback, createLocalBridgePairing } from "@mongolgpt/local-bridge"
import { createLocalBridgeClient, isLocalBridgeCallback } from "./local-bridge-client"

const origin = "https://app.dev.mgpt.mn"
const token = "A".repeat(43)

function storage() {
  const values = new Map<string, string>()
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  }
}

async function setup() {
  const store = storage()
  const launched: string[] = []
  const cleared: string[] = []
  let currentTime = 1_000_000
  const client = createLocalBridgeClient({
    origin,
    now: () => currentTime,
    storage: store,
    replaceURL: (url) => void cleared.push(url),
    launchDesktop: (url) => void launched.push(url),
  })
  await client.begin("account-1")
  const pairingURL = launched[0]
  const pairing = await createLocalBridgePairing({
    origin,
    accountID: "account-1",
    randomBytes: () => new Uint8Array(32).fill(7),
  })
  return {
    client,
    store,
    launched,
    cleared,
    pairingURL,
    pairing,
    setTime: (value: number) => void (currentTime = value),
  }
}

function response(body: unknown, status = 200, contentType = "application/json") {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": contentType } })
}

test("begin stores one pending record and launches the desktop pairing URL", async () => {
  const store = storage()
  const launched: string[] = []
  const client = createLocalBridgeClient({
    origin,
    now: () => 1000,
    storage: store,
    replaceURL: () => undefined,
    launchDesktop: (url) => void launched.push(url),
  })
  const result = await client.begin("account-1")
  expect(launched).toHaveLength(1)
  expect(launched[0]).toStartWith("mongolgpt://bridge/pair?")
  expect(store.values.size).toBe(1)
  expect(JSON.parse([...store.values.values()][0]).accountID).toBe("account-1")
  expect(result.expiresAt).toBe(601_000)
})

test("callback exchanges exact JSON over loopback and returns memory-ready credentials", async () => {
  const store = storage()
  const cleared: string[] = []
  const launched: string[] = []
  let now = 1000
  const client = createLocalBridgeClient({
    origin,
    now: () => now,
    storage: store,
    replaceURL: (url) => void cleared.push(url),
    launchDesktop: (url) => void launched.push(url),
    fetch: async (input, init) => {
      const requestURL = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      expect(requestURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/bridge\/v1\/session$/)
      expect(init?.method).toBe("POST")
      expect(init?.headers).toEqual({ "content-type": "application/json" })
      expect(init?.targetAddressSpace).toBe("loopback")
      if (typeof init?.body !== "string") throw new Error("JSON request body expected")
      expect(JSON.parse(init.body)).toEqual({ code: "C".repeat(43), verifier: expect.any(String) })
      return response({
        authenticated: true,
        username: "bridge",
        token,
        accountID: "account-1",
        expiresAt: now + 900_000,
      })
    },
  })
  await client.begin("account-1")
  const pending = JSON.parse([...store.values.values()][0])
  const callback = createLocalBridgeCallback({ origin, state: pending.state, port: 4321, code: "C".repeat(43) })
  const connection = await client.callback(callback)
  expect(connection).toEqual({
    url: "http://127.0.0.1:4321",
    username: "bridge",
    password: token,
    accountID: "account-1",
    expiresAt: 901_000,
  })
  expect(store.values.size).toBe(0)
  expect(cleared[0]).toBe(origin + "/")
  expect(launched).toHaveLength(1)
})

test("rejects missing callback and state mismatch without leaking pending secrets", async () => {
  const fixture = await setup()
  await expect(fixture.client.callback(origin)).rejects.toThrow("Локал холболтын хариу буруу байна")
  const mismatched = createLocalBridgeCallback({ origin, state: "B".repeat(43), port: 4321, code: "C".repeat(43) })
  await expect(fixture.client.callback(mismatched)).rejects.toThrow("Локал холболтын төлөв таарахгүй байна")
  expect([...fixture.store.values.values()][0]).not.toContain(fixture.pairing.verifier)
  expect(fixture.cleared.at(-1)).toBe(origin + "/")
})

test("recognizes only an exact bridge callback and clears a callback with no pending request", async () => {
  const callback = createLocalBridgeCallback({ origin, state: "B".repeat(43), port: 4321, code: "C".repeat(43) })
  expect(isLocalBridgeCallback(callback, origin)).toBe(true)
  expect(isLocalBridgeCallback(`${origin}/#bridge=mongolgpt-bridge-v1`, origin)).toBe(false)

  const cleared: string[] = []
  const client = createLocalBridgeClient({
    origin,
    storage: storage(),
    replaceURL: (url) => void cleared.push(url),
    launchDesktop: () => undefined,
  })
  await expect(client.callback(callback)).rejects.toThrow("Идэвхтэй локал холболтын хүсэлт алга байна")
  expect(cleared).toEqual([origin + "/"])
})

test("cleans state and fragment on expiry, malformed response, account mismatch, and HTTP failure", async () => {
  const fixture = await setup()
  const expiredPending = JSON.parse([...fixture.store.values.values()][0])
  const expiredCallback = createLocalBridgeCallback({
    origin,
    state: expiredPending.state,
    port: 4321,
    code: "C".repeat(43),
  })
  fixture.setTime(expiredPending.expiresAt + 1)
  await expect(fixture.client.callback(expiredCallback)).rejects.toThrow("хугацаа дууссан байна")
  expect(fixture.store.values.size).toBe(0)

  const store = storage()
  const cleared: string[] = []
  let now = 1000
  const client = createLocalBridgeClient({
    origin,
    now: () => now,
    storage: store,
    replaceURL: (url) => void cleared.push(url),
    launchDesktop: () => undefined,
    fetch: async () => response({ nope: true }),
  })
  await client.begin("account-1")
  const pending = JSON.parse([...store.values.values()][0])
  const callback = createLocalBridgeCallback({ origin, state: pending.state, port: 4321, code: "C".repeat(43) })
  await expect(client.callback(callback)).rejects.toThrow()
  expect(store.values.size).toBe(0)
  expect(cleared[0]).toBe(origin + "/")

  const failureStore = storage()
  const failing = createLocalBridgeClient({
    origin,
    now: () => now,
    storage: failureStore,
    replaceURL: () => undefined,
    launchDesktop: () => undefined,
    fetch: async () => response({}, 500),
  })
  await failing.begin("account-1")
  const failurePending = JSON.parse([...failureStore.values.values()][0])
  const failureCallback = createLocalBridgeCallback({
    origin,
    state: failurePending.state,
    port: 4321,
    code: "C".repeat(43),
  })
  await expect(failing.callback(failureCallback)).rejects.toThrow()
  expect(failureStore.values.size).toBe(0)
})

test("rejects non-JSON and mismatched account responses", async () => {
  for (const body of [
    { authenticated: true, username: "bridge", token, accountID: "other", expiresAt: 901_000 },
    { authenticated: true, username: "bridge", token, accountID: "account-1", expiresAt: 901_000 },
  ]) {
    const store = storage()
    const client = createLocalBridgeClient({
      origin,
      now: () => 1000,
      storage: store,
      replaceURL: () => undefined,
      launchDesktop: () => undefined,
      fetch: async () => response(body, 200, body.accountID === "other" ? "application/json" : "text/plain"),
    })
    await client.begin("account-1")
    const pending = JSON.parse([...store.values.values()][0])
    const callback = createLocalBridgeCallback({ origin, state: pending.state, port: 4321, code: "C".repeat(43) })
    await expect(client.callback(callback)).rejects.toThrow()
  }
})
