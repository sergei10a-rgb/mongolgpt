export function describeDeepLink(value: string) {
  try {
    const url = new URL(value)
    if (url.protocol !== "mongolgpt:") return "invalid"
    const path = url.pathname.replace(/^\/+/, "")
    return [url.hostname, path].filter(Boolean).join("/") || "root"
  } catch {
    return "invalid"
  }
}

export function describeDeepLinks(values: readonly string[]) {
  return values.map(describeDeepLink)
}
