import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

const ALGORITHM = "aes-256-gcm"
const KEY_BYTES = 32
const NONCE_BYTES = 12
const PREFIX = "mgpt:v1:"
const AAD = Buffer.from("mongolgpt-account-token:v1", "utf8")

type Envelope = {
  nonce: Buffer
  tag: Buffer
  ciphertext: Buffer
}

function parseEnvelope(value: string): Envelope | undefined {
  if (!value.startsWith(PREFIX)) return
  const parts = value.slice(PREFIX.length).split(":")
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) return

  const nonce = Buffer.from(parts[0], "base64url")
  const tag = Buffer.from(parts[1], "base64url")
  const ciphertext = Buffer.from(parts[2], "base64url")
  if (
    nonce.byteLength !== NONCE_BYTES ||
    tag.byteLength !== 16 ||
    ciphertext.byteLength === 0 ||
    nonce.toString("base64url") !== parts[0] ||
    tag.toString("base64url") !== parts[1] ||
    ciphertext.toString("base64url") !== parts[2]
  ) {
    return
  }
  return { nonce, tag, ciphertext }
}

const isProtectedEnvelope = (value: string) => parseEnvelope(value) !== undefined

export class AccountTokenCodecError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "AccountTokenCodecError"
  }
}

export type AccountTokenCodec = {
  readonly enabled: boolean
  readonly protected: (value: string) => boolean
  readonly protect: (value: string) => string
  readonly unprotect: (value: string) => string
}

const unavailable: AccountTokenCodec = {
  enabled: false,
  protected: isProtectedEnvelope,
  protect: () => {
    throw new AccountTokenCodecError(
      "Бүртгэлийн token шифрлэх түлхүүр тохируулагдаагүй байна. Үйлдлийн системийн нууцлалын санг идэвхжүүлнэ үү.",
    )
  },
  unprotect: (value) => {
    throw new AccountTokenCodecError(
      isProtectedEnvelope(value)
        ? "Шифрлэгдсэн бүртгэлийн token-ийг тайлах түлхүүр олдсонгүй."
        : "Бүртгэлийн token plaintext хэлбэрээр ашиглахаас татгалзлаа.",
    )
  },
}

export function createAccountTokenCodec(key?: Uint8Array): AccountTokenCodec {
  if (!key) return unavailable
  if (key.byteLength !== KEY_BYTES) {
    throw new AccountTokenCodecError(`Бүртгэлийн token шифрлэх түлхүүр ${KEY_BYTES} byte байх ёстой.`)
  }

  const secret = Buffer.from(key)
  return {
    enabled: true,
    protected: isProtectedEnvelope,
    protect(value) {
      if (isProtectedEnvelope(value)) {
        throw new AccountTokenCodecError("Шифрлэгдсэн утгыг давхар шифрлэхээс татгалзлаа.")
      }
      const nonce = randomBytes(NONCE_BYTES)
      const cipher = createCipheriv(ALGORITHM, secret, nonce)
      cipher.setAAD(AAD)
      const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()])
      const tag = cipher.getAuthTag()
      return `${PREFIX}${nonce.toString("base64url")}:${tag.toString("base64url")}:${ciphertext.toString("base64url")}`
    },
    unprotect(value) {
      if (!value.startsWith(PREFIX)) return value
      const envelope = parseEnvelope(value)
      if (!envelope) {
        throw new AccountTokenCodecError("Шифрлэгдсэн бүртгэлийн token-ийн бүтэц буруу байна.")
      }

      try {
        const decipher = createDecipheriv(ALGORITHM, secret, envelope.nonce)
        decipher.setAAD(AAD)
        decipher.setAuthTag(envelope.tag)
        return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString("utf8")
      } catch (cause) {
        throw new AccountTokenCodecError("Бүртгэлийн token-ийг тайлж чадсангүй.", { cause })
      }
    },
  }
}

let configured = unavailable

export function configureAccountTokenEncryptionKey(key: Uint8Array) {
  configured = createAccountTokenCodec(key)
}

export function configuredAccountTokenCodec() {
  return configured
}

export function assertAccountTokenEncryptionConfigured() {
  if (configured.enabled) return
  throw new AccountTokenCodecError(
    "Бүртгэлийн token хамгаалах үйлдлийн системийн нууцлалын сан боломжгүй байна. Headless орчинд MONGOLGPT_ACCOUNT_TOKEN_KEY-д 32 byte base64url түлхүүр тохируулна уу.",
  )
}
