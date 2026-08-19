import { describe, expect, test } from "bun:test"
import { loadOrCreateAccountVaultKey, type AccountVaultKeySafeStorage } from "./account-vault-key"

const storageKey = "account-vault"

function createStorage(initial?: string) {
  const values = new Map(initial === undefined ? [] : [[storageKey, initial]])
  return {
    values,
    get(key: string) {
      return values.get(key)
    },
    set(key: string, value: string) {
      values.set(key, value)
    },
  }
}

function createSafeStorage(overrides: Partial<AccountVaultKeySafeStorage> = {}): AccountVaultKeySafeStorage {
  const encode = (value: string) => Uint8Array.from(Buffer.from(value.split("").reverse().join(""), "utf8"))
  const decode = (value: Uint8Array) => Buffer.from(value).toString("utf8").split("").reverse().join("")
  return {
    isEncryptionAvailable: () => true,
    encryptString: encode,
    decryptString: decode,
    ...overrides,
  }
}

function fixedKey() {
  return Uint8Array.from({ length: 32 }, (_, index) => index + 1)
}

describe("loadOrCreateAccountVaultKey", () => {
  test("creates and persists exactly 32 random bytes in an encrypted envelope", () => {
    const expected = fixedKey()
    const generated = expected.slice()
    const storage = createStorage()
    let requestedLength = 0

    const key = loadOrCreateAccountVaultKey({
      storage,
      safeStorage: createSafeStorage(),
      randomness: { randomBytes: (length) => ((requestedLength = length), generated) },
      storageKey,
    })
    expect(key).toEqual(expected)
    expect(generated).toEqual(new Uint8Array(32))

    const persisted = storage.values.get(storageKey) as string
    const envelope = JSON.parse(persisted) as { version: number; ciphertext: string }
    const plaintext = Buffer.from(expected).toString("base64")
    expect(requestedLength).toBe(32)
    expect(envelope.version).toBe(1)
    expect(envelope.ciphertext).not.toContain(plaintext)
    expect(persisted).not.toContain(Buffer.from(key).toString())
    expect(persisted).not.toContain(plaintext)
  })

  test("clears a newly generated key when encrypted persistence fails", () => {
    const generated = fixedKey()
    const storage = createStorage()
    storage.set = () => {
      throw new Error("write failed")
    }

    expect(() =>
      loadOrCreateAccountVaultKey({
        storage,
        safeStorage: createSafeStorage(),
        randomness: { randomBytes: () => generated },
        storageKey,
      }),
    ).toThrow("write failed")
    expect(generated).toEqual(new Uint8Array(32))
  })

  test("reuses the decrypted key after restart", () => {
    const storage = createStorage()
    const safeStorage = createSafeStorage()
    const first = loadOrCreateAccountVaultKey({
      storage,
      safeStorage,
      randomness: { randomBytes: () => fixedKey() },
      storageKey,
    })
    const second = loadOrCreateAccountVaultKey({
      storage,
      safeStorage,
      randomness: {
        randomBytes: () => {
          throw new Error("randomness should not be used")
        },
      },
      storageKey,
    })

    expect(second).toEqual(first)
  })

  test("refuses to create or read when OS encryption is unavailable", () => {
    const safeStorage = createSafeStorage({ isEncryptionAvailable: () => false })
    const randomness = {
      randomBytes: () => {
        throw new Error("randomness should not be used")
      },
    }

    const storage = createStorage()
    expect(() => loadOrCreateAccountVaultKey({ storage, safeStorage, randomness, storageKey })).toThrow(
      "Үйлдлийн системийн нууцлалын сан боломжгүй байна",
    )
    expect(storage.values.has(storageKey)).toBe(false)

    const existingStorage = createStorage(JSON.stringify({ version: 1, ciphertext: "Y2lwaGVydGV4dA==" }))
    expect(() =>
      loadOrCreateAccountVaultKey({ storage: existingStorage, safeStorage, randomness, storageKey }),
    ).toThrow("Үйлдлийн системийн нууцлалын сан боломжгүй байна")
  })

  test("refuses Linux basic_text storage", () => {
    const storage = createStorage()
    const safeStorage = createSafeStorage({ getSelectedStorageBackend: () => "basic_text" })

    expect(() =>
      loadOrCreateAccountVaultKey({ storage, safeStorage, randomness: { randomBytes: fixedKey }, storageKey }),
    ).toThrow("Үйлдлийн системийн нууцлалын сан plaintext горим ашиглаж байна")
    expect(storage.values.has(storageKey)).toBe(false)
  })

  test.each(["not json", JSON.stringify({ version: 99, ciphertext: "ciphertext" }), JSON.stringify({ version: 1 })])(
    "rejects corrupt or unknown-version envelopes: %s",
    (persisted) => {
      const storage = createStorage(persisted)
      const call = () =>
        loadOrCreateAccountVaultKey({
          storage,
          safeStorage: createSafeStorage(),
          randomness: { randomBytes: fixedKey },
          storageKey,
        })
      if (persisted.includes('"version":99')) expect(call).toThrow("Хадгалсан түлхүүрийн хувилбар танигдсангүй")
      else expect(call).toThrow("Хадгалсан түлхүүрийн бүрхүүл гэмтсэн байна")
    },
  )

  test("rejects a decrypted key with the wrong length", () => {
    const ciphertext = Buffer.from("ciphertext", "utf8").toString("base64")
    const storage = createStorage(JSON.stringify({ version: 1, ciphertext }))
    const safeStorage = createSafeStorage({ decryptString: () => Buffer.from(Buffer.alloc(31)).toString("base64") })

    expect(() =>
      loadOrCreateAccountVaultKey({ storage, safeStorage, randomness: { randomBytes: fixedKey }, storageKey }),
    ).toThrow("Хадгалсан түлхүүрийн урт буруу байна")
  })
})
