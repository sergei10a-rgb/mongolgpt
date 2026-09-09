import { expect, test } from "bun:test"
import { createSandboxRetirement } from "../src/sandbox-retirement"

const marker = { accountID: "acc_retired", workspaceID: "wrk_retired", requestID: "del_retired" }
function storage() {
  const values = new Map<string, unknown>()
  return {
    values,
    store: {
      async get<T>(key: string) {
        return values.get(key) as T | undefined
      },
      async put(key: string, value: unknown) {
        values.set(key, structuredClone(value))
      },
    } as Pick<DurableObjectStorage, "get" | "put">,
  }
}

test("sealing blocks new operations while draining already admitted work", async () => {
  const fixture = storage()
  const gate = createSandboxRetirement(fixture.store)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const operation = gate.run(async () => {
    entered.resolve()
    await release.promise
    return 42
  })
  await entered.promise
  await gate.seal(marker)
  let enteredAfterSeal = false
  await expect(
    gate.run(async () => {
      enteredAfterSeal = true
    }),
  ).rejects.toThrow("хаагдсан")
  expect(enteredAfterSeal).toBe(false)
  let drained = false
  const waiting = gate.drain().then(() => {
    drained = true
  })
  await Promise.resolve()
  expect(drained).toBe(false)
  release.resolve()
  expect(await operation).toBe(42)
  await waiting
  expect(drained).toBe(true)
  const reloaded = createSandboxRetirement(fixture.store)
  await expect(reloaded.run(async () => 1)).rejects.toThrow("хаагдсан")
  await reloaded.seal(marker)
  await reloaded.drain()
  expect(fixture.values.size).toBe(1)
})

test("uncertain persistence does not reopen admission and can be retried", async () => {
  const fixture = storage()
  let writes = 0
  const gate = createSandboxRetirement({
    ...fixture.store,
    put: (async (key: string, value: unknown) => {
      await fixture.store.put(key, value)
      if (++writes === 1) throw new Error("acknowledgement lost")
    }) as DurableObjectStorage["put"],
  })
  await expect(gate.seal(marker)).rejects.toThrow("acknowledgement lost")
  await expect(gate.run(async () => 1)).rejects.toThrow("хаагдсан")
  await gate.seal(marker)
  expect(writes).toBe(2)
  await expect(createSandboxRetirement(fixture.store).run(async () => 1)).rejects.toThrow("хаагдсан")
})

test("a seal cannot be replaced by another account, workspace or deletion request", async () => {
  const fixture = storage()
  const gate = createSandboxRetirement(fixture.store)
  await gate.seal(marker)
  for (const property of ["accountID", "workspaceID", "requestID"] as const)
    await expect(gate.seal({ ...marker, [property]: "different" })).rejects.toThrow("зөрсөн")
  expect([...fixture.values.values()]).toEqual([marker])
})

test("corrupt or unavailable durable state fails closed", async () => {
  for (const value of [null, {}, { ...marker, accountID: "../escape" }, { ...marker, extra: true }]) {
    const fixture = storage()
    fixture.values.set("mongolgpt:retired:v1", value)
    const gate = createSandboxRetirement(fixture.store)
    await expect(gate.run(async () => 1)).rejects.toThrow("буруу")
    await expect(gate.seal(marker)).rejects.toThrow("буруу")
  }
  const fixture = storage()
  const gate = createSandboxRetirement({
    ...fixture.store,
    get: (async () => {
      throw new Error("storage unavailable")
    }) as DurableObjectStorage["get"],
  })
  await expect(gate.run(async () => 1)).rejects.toThrow("storage unavailable")
  await expect(gate.seal(marker)).rejects.toThrow("storage unavailable")
})

test("drain requires sealing and tolerates a failed admitted operation", async () => {
  const gate = createSandboxRetirement(storage().store)
  await expect(gate.drain()).rejects.toThrow("эхлээгүй")
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const failed = gate
    .run(async () => {
      entered.resolve()
      await release.promise
      throw new Error("stopped")
    })
    .catch((error: unknown) => error)
  await entered.promise
  await gate.seal(marker)
  release.resolve()
  await gate.drain()
  expect(await failed).toBeInstanceOf(Error)
  expect(((await failed) as Error).message).toBe("stopped")
})
