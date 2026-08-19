const ACCOUNT_VAULT_KEY_VERSION = 1
const ACCOUNT_VAULT_KEY_BYTES = 32
export const ACCOUNT_VAULT_KEY_STORAGE_KEY = "accountVaultKey"

export interface AccountVaultKeyStorage {
  get(key: string): string | undefined
  set(key: string, value: string): void
}

export interface AccountVaultKeySafeStorage {
  isEncryptionAvailable(): boolean
  getSelectedStorageBackend?(): string
  encryptString(value: string): Uint8Array
  decryptString(value: Uint8Array): string
}

export interface AccountVaultKeyRandomness {
  randomBytes(length: number): Uint8Array
}

export function loadOrCreateAccountVaultKey(options: {
  storage: AccountVaultKeyStorage
  safeStorage: AccountVaultKeySafeStorage
  randomness: AccountVaultKeyRandomness
  storageKey?: string
}): Uint8Array {
  if (!options.safeStorage.isEncryptionAvailable()) throw new Error("Үйлдлийн системийн нууцлалын сан боломжгүй байна")
  if (options.safeStorage.getSelectedStorageBackend?.() === "basic_text") {
    throw new Error("Үйлдлийн системийн нууцлалын сан plaintext горим ашиглаж байна")
  }

  const storageKey = options.storageKey ?? ACCOUNT_VAULT_KEY_STORAGE_KEY
  const persisted = options.storage.get(storageKey)
  if (persisted === undefined) {
    const key = options.randomness.randomBytes(ACCOUNT_VAULT_KEY_BYTES)
    try {
      if (key.length !== ACCOUNT_VAULT_KEY_BYTES) throw new Error("Түлхүүр үүсгэгч буруу урттай түлхүүр буцаалаа")

      const envelope = {
        version: ACCOUNT_VAULT_KEY_VERSION,
        ciphertext: encodeBase64(options.safeStorage.encryptString(encodeBase64(key))),
      }
      options.storage.set(storageKey, JSON.stringify(envelope))
      return key.slice()
    } finally {
      key.fill(0)
    }
  }

  const envelope = parseEnvelope(persisted)
  let encodedKey: string
  try {
    const ciphertext = decodeBase64(envelope.ciphertext)
    if (ciphertext === undefined) throw new Error("Шифрлэсэн өгөгдөл буруу байна")
    encodedKey = options.safeStorage.decryptString(ciphertext)
  } catch {
    throw new Error("Хадгалсан түлхүүрийг тайлж чадсангүй")
  }

  const key = decodeBase64(encodedKey)
  if (key === undefined) throw new Error("Хадгалсан түлхүүрийн өгөгдөл гэмтсэн байна")
  if (key.length !== ACCOUNT_VAULT_KEY_BYTES) throw new Error("Хадгалсан түлхүүрийн урт буруу байна")
  return key
}

function parseEnvelope(value: string): { version: number; ciphertext: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error("Хадгалсан түлхүүрийн бүрхүүл гэмтсэн байна")
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    !Object.hasOwn(parsed, "version") ||
    !Object.hasOwn(parsed, "ciphertext") ||
    Object.keys(parsed).length !== 2
  ) {
    throw new Error("Хадгалсан түлхүүрийн бүрхүүл гэмтсэн байна")
  }

  const envelope = parsed as { version: unknown; ciphertext: unknown }
  if (envelope.version !== ACCOUNT_VAULT_KEY_VERSION) throw new Error("Хадгалсан түлхүүрийн хувилбар танигдсангүй")
  if (typeof envelope.ciphertext !== "string" || envelope.ciphertext.length === 0) {
    throw new Error("Хадгалсан түлхүүрийн бүрхүүл гэмтсэн байна")
  }
  return { version: ACCOUNT_VAULT_KEY_VERSION, ciphertext: envelope.ciphertext }
}

function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64")
}

function decodeBase64(value: string): Uint8Array | undefined {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return undefined
  const bytes = Uint8Array.from(Buffer.from(value, "base64"))
  return encodeBase64(bytes) === value ? bytes : undefined
}
