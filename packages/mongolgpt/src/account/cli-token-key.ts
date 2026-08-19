import { randomBytes, timingSafeEqual } from "node:crypto"
import { secrets } from "bun"
import { Flock } from "@mongolgpt/core/util/flock"

import { configureAccountTokenEncryptionKey } from "./token-codec"

const KEY_BYTES = 32
const SECRET_SERVICE = "mn.mgpt.mongolgpt"
const SECRET_NAME = "account-token-encryption-key-v1"
const LOCK_KEY = "account-token-encryption-key-v1"

type SecretCoordinates = { service: string; name: string }

export type AccountTokenSecretStore = {
  get(input: SecretCoordinates): Promise<string | null>
  set(input: SecretCoordinates & { value: string }): Promise<void>
}

export type CliAccountTokenKeyOptions = {
  secrets?: AccountTokenSecretStore
  randomBytes?: (length: number) => Uint8Array
  withLock?: <T>(run: () => Promise<T>) => Promise<T>
  environment?: Record<string, string | undefined>
}

const bunSecrets: AccountTokenSecretStore = {
  get: (input) => secrets.get(input),
  set: (input) => secrets.set(input),
}

export async function loadOrCreateCliAccountTokenKey(options: CliAccountTokenKeyOptions = {}) {
  const environment = options.environment ?? process.env
  const supplied = environment.MONGOLGPT_ACCOUNT_TOKEN_KEY
  if (supplied !== undefined) delete environment.MONGOLGPT_ACCOUNT_TOKEN_KEY
  if (supplied) return decodeKey(supplied, "MONGOLGPT_ACCOUNT_TOKEN_KEY")

  const store = options.secrets ?? bunSecrets
  const createRandomBytes = options.randomBytes ?? randomBytes
  const withLock = options.withLock ?? ((run) => Flock.withLock(LOCK_KEY, run))

  return withLock(async () => {
    const existing = await store.get({ service: SECRET_SERVICE, name: SECRET_NAME })
    if (existing !== null) return decodeKey(existing, "үйлдлийн системийн нууцлалын сан")

    const generated = createRandomBytes(KEY_BYTES)
    try {
      if (generated.byteLength !== KEY_BYTES) throw new Error("Түлхүүр үүсгэгч буруу урттай түлхүүр буцаалаа")
      const encoded = encodeKey(generated)
      await store.set({ service: SECRET_SERVICE, name: SECRET_NAME, value: encoded })

      const persisted = await store.get({ service: SECRET_SERVICE, name: SECRET_NAME })
      if (persisted === null) throw new Error("Үйлдлийн системийн нууцлалын сан түлхүүрийг хадгалсангүй")
      const verified = decodeKey(persisted, "үйлдлийн системийн нууцлалын сан")
      if (!timingSafeEqual(Buffer.from(generated), Buffer.from(verified))) {
        verified.fill(0)
        throw new Error("Үйлдлийн системийн нууцлалын санд хадгалсан түлхүүр зөрүүтэй байна")
      }
      verified.fill(0)
      return generated.slice()
    } finally {
      generated.fill(0)
    }
  })
}

export async function initializeCliAccountTokenEncryption(options: CliAccountTokenKeyOptions = {}) {
  const key = await loadOrCreateCliAccountTokenKey(options)
  try {
    configureAccountTokenEncryptionKey(key)
  } finally {
    key.fill(0)
  }
}

function encodeKey(key: Uint8Array) {
  return Buffer.from(key).toString("base64url")
}

function decodeKey(value: string, source: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${source}-д хадгалсан түлхүүрийн бүтэц буруу байна`)
  const key = Uint8Array.from(Buffer.from(value, "base64url"))
  if (key.byteLength !== KEY_BYTES || encodeKey(key) !== value) {
    key.fill(0)
    throw new Error(`${source}-д хадгалсан түлхүүрийн урт эсвэл encoding буруу байна`)
  }
  return key
}
