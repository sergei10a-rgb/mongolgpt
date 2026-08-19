import { describe, expect, test } from "bun:test"

import { loadOrCreateCliAccountTokenKey, type AccountTokenSecretStore } from "../../src/account/cli-token-key"

function memorySecrets(initial: string | null = null) {
  let value = initial
  const store: AccountTokenSecretStore = {
    async get() {
      return value
    },
    async set(input) {
      value = input.value
    },
  }
  return { store, value: () => value }
}

const unlocked = <T>(run: () => Promise<T>) => run()

describe("CLI account token key", () => {
  test("creates the key once in the OS secret store and reuses it", async () => {
    const memory = memorySecrets()
    const generated = new Uint8Array(32).fill(17)
    const first = await loadOrCreateCliAccountTokenKey({
      secrets: memory.store,
      randomBytes: () => generated,
      withLock: unlocked,
      environment: {},
    })
    const second = await loadOrCreateCliAccountTokenKey({
      secrets: memory.store,
      randomBytes: () => new Uint8Array(32).fill(99),
      withLock: unlocked,
      environment: {},
    })

    expect(first).toEqual(new Uint8Array(32).fill(17))
    expect(second).toEqual(first)
    expect(memory.value()).toBe(Buffer.from(first).toString("base64url"))
    expect(generated).toEqual(new Uint8Array(32))
  })

  test("accepts an explicit headless environment key without touching the OS store", async () => {
    let touched = false
    const key = new Uint8Array(32).fill(23)
    const environment = { MONGOLGPT_ACCOUNT_TOKEN_KEY: Buffer.from(key).toString("base64url") }
    const result = await loadOrCreateCliAccountTokenKey({
      secrets: {
        async get() {
          touched = true
          return null
        },
        async set() {
          touched = true
        },
      },
      withLock: unlocked,
      environment,
    })

    expect(result).toEqual(key)
    expect(touched).toBe(false)
    expect(environment).not.toHaveProperty("MONGOLGPT_ACCOUNT_TOKEN_KEY")
  })

  test("removes a malformed environment key before rejecting it", async () => {
    const environment = { MONGOLGPT_ACCOUNT_TOKEN_KEY: "not base64!" }

    await expect(
      loadOrCreateCliAccountTokenKey({
        secrets: memorySecrets().store,
        withLock: unlocked,
        environment,
      }),
    ).rejects.toThrow("бүтэц буруу")
    expect(environment).not.toHaveProperty("MONGOLGPT_ACCOUNT_TOKEN_KEY")
  })

  test("rejects malformed or wrong-length persisted keys", async () => {
    for (const value of ["not base64!", Buffer.alloc(31).toString("base64url")]) {
      await expect(
        loadOrCreateCliAccountTokenKey({
          secrets: memorySecrets(value).store,
          withLock: unlocked,
          environment: {},
        }),
      ).rejects.toThrow()
    }
  })

  test("fails closed and clears the generated key when persistence fails", async () => {
    const generated = new Uint8Array(32).fill(31)
    await expect(
      loadOrCreateCliAccountTokenKey({
        secrets: {
          async get() {
            return null
          },
          async set() {
            throw new Error("write failed")
          },
        },
        randomBytes: () => generated,
        withLock: unlocked,
        environment: {},
      }),
    ).rejects.toThrow("write failed")
    expect(generated).toEqual(new Uint8Array(32))
  })

  test("rejects a secret store readback mismatch", async () => {
    const generated = new Uint8Array(32).fill(41)
    const replacement = Buffer.from(new Uint8Array(32).fill(42)).toString("base64url")
    let reads = 0
    await expect(
      loadOrCreateCliAccountTokenKey({
        secrets: {
          async get() {
            reads += 1
            return reads === 1 ? null : replacement
          },
          async set() {},
        },
        randomBytes: () => generated,
        withLock: unlocked,
        environment: {},
      }),
    ).rejects.toThrow("зөрүүтэй")
    expect(generated).toEqual(new Uint8Array(32))
  })
})
