const shareID = /^[a-zA-Z0-9_-]+$/

export function parseShareUrl(input: string): string | null {
  try {
    const url = new URL(input)
    if (url.protocol !== "https:" && url.protocol !== "http:") return null
    if (url.username || url.password || url.search || url.hash) return null

    const match = url.pathname.match(/^\/share\/([^/]+)$/)
    if (!match || !shareID.test(match[1])) return null
    return match[1]
  } catch {
    return null
  }
}

export function extractShareUrl(input: string): string | null {
  const candidates = input.match(/https?:\/\/[^\s<>"']+/gi) ?? []
  for (const item of candidates) {
    const candidate = item.replace(/[),.;!?]+$/g, "")
    if (parseShareUrl(candidate)) return candidate
  }
  return null
}
