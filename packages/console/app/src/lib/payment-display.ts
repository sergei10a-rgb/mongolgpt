const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const
const MAX_QR_BYTES = 1_500_000
const PNG_DATA_PREFIX = "data:image/png;base64,"
const BLOCKED_PROTOCOLS = new Set(["http:", "javascript:", "data:", "vbscript:", "file:", "blob:"])

export function safeQrImage(value: string | undefined) {
  if (!value) return undefined
  const encoded = value.startsWith(PNG_DATA_PREFIX) ? value.slice(PNG_DATA_PREFIX.length) : value
  if (encoded.length === 0 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    return undefined
  }
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0
  const decodedBytes = (encoded.length / 4) * 3 - padding
  if (decodedBytes > MAX_QR_BYTES) return undefined

  try {
    const header = atob(encoded.slice(0, 12))
    if (PNG_SIGNATURE.some((byte, index) => header.charCodeAt(index) !== byte)) return undefined
  } catch {
    return undefined
  }
  return `${PNG_DATA_PREFIX}${encoded}`
}

export function safeHttpsHref(value: string | undefined) {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return url.protocol === "https:" ? url.href : undefined
  } catch {
    return undefined
  }
}

export function safePaymentDeepLink(value: string) {
  try {
    const url = new URL(value)
    return BLOCKED_PROTOCOLS.has(url.protocol.toLowerCase()) ? undefined : url.href
  } catch {
    return undefined
  }
}
