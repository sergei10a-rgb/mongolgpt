import { Resource } from "@mongolgpt/console-resource"

const prefix = "mgp-byok"
const version = "v1"
const activeKeyID = "k1"
const encoder = new TextEncoder()
const decoder = new TextDecoder()

export namespace ProviderCredentials {
  export function encrypted(value: string) {
    return value.startsWith(`${prefix}:`)
  }

  export function supported(value: string) {
    const parts = value.split(":")
    return (
      parts.length === 5 &&
      parts[0] === prefix &&
      parts[1] === version &&
      parts[2].length > 0 &&
      parts[3].length > 0 &&
      parts[4].length > 0
    )
  }

  export async function encrypt(input: {
    workspaceID: string
    provider: string
    credentials: string
    keyMaterial?: string
  }) {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: additionalData(activeKeyID, input.workspaceID, input.provider),
      },
      await key(activeKeyID, input.keyMaterial),
      encoder.encode(input.credentials),
    )
    return [prefix, version, activeKeyID, encode(iv), encode(new Uint8Array(ciphertext))].join(":")
  }

  export async function decrypt(input: {
    workspaceID: string
    provider: string
    credentials: string
    keyMaterial?: string
  }) {
    if (!encrypted(input.credentials)) return input.credentials

    if (!supported(input.credentials)) {
      throw new Error("Provider credential envelope is invalid")
    }
    const parts = input.credentials.split(":")
    const keyID = parts[2]

    try {
      const plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: decode(parts[3]),
          additionalData: additionalData(keyID, input.workspaceID, input.provider),
        },
        await key(keyID, input.keyMaterial),
        decode(parts[4]),
      )
      return decoder.decode(plaintext)
    } catch {
      throw new Error("Provider credentials could not be decrypted")
    }
  }
}

function additionalData(keyID: string, workspaceID: string, provider: string) {
  return encoder.encode(`${version}\0${keyID}\0${workspaceID}\0${provider}`)
}

async function key(keyID: string, keyMaterial = keyring(keyID)) {
  if (!keyMaterial) throw new Error("Provider credential encryption key is not configured")
  return crypto.subtle.importKey(
    "raw",
    await crypto.subtle.digest("SHA-256", encoder.encode(keyMaterial)),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  )
}

// Keep previous key IDs here until every row has been rewrapped with the active key.
function keyring(keyID: string) {
  if (keyID === "k1") return Resource.ByokCredentialsKeyV1.value
  throw new Error("Provider credential encryption key is not available")
}

function encode(value: Uint8Array) {
  return btoa(Array.from(value, (byte) => String.fromCharCode(byte)).join(""))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

function decode(value: string) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/")
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0))
}
