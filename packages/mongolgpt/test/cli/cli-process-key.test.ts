import { expect, test } from "bun:test"
import { loadOrCreateCliAccountTokenKey } from "../../src/account/cli-token-key"
import { isolatedEnv } from "../lib/cli-process"

test("CLI fixtures use independent keys without accessing the host credential store", async () => {
  const first = isolatedEnv("fixture-first", "{}")
  const second = isolatedEnv("fixture-second", "{}")
  const keys: Uint8Array[] = []
  const unexpected = () => {
    throw new Error("CLI fixture accessed the host credential store")
  }

  try {
    for (const environment of [first, { ...first }, second]) {
      keys.push(
        await loadOrCreateCliAccountTokenKey({
          environment,
          withLock: unexpected,
          secrets: { get: unexpected, set: unexpected },
        }),
      )
      expect(environment.MONGOLGPT_ACCOUNT_TOKEN_KEY === undefined).toBe(true)
    }
    expect(keys.every((key) => key.byteLength === 32)).toBe(true)
    expect(Buffer.from(keys[0]).equals(Buffer.from(keys[1]))).toBe(true)
    expect(Buffer.from(keys[0]).equals(Buffer.from(keys[2]))).toBe(false)
  } finally {
    for (const key of keys) key.fill(0)
  }
})
