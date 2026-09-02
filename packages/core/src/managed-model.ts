type ModelCost = {
  readonly input: number
  readonly output: number
}

export function isManagedFreeModel(input: {
  readonly id: string
  readonly cost?: ModelCost | readonly ModelCost[]
}) {
  if (input.id === "free-auto") return true
  if (!input.cost) return false
  const costs = Array.isArray(input.cost) ? input.cost : [input.cost]
  return costs.length > 0 && costs.every((cost) => cost.input === 0 && cost.output === 0)
}

export function isOpenCodePublicApi(value: string | undefined) {
  if (!value) return false
  try {
    const url = new URL(value)
    return url.protocol === "https:" && url.hostname === "opencode.ai" && /^\/zen(?:\/|$)/.test(url.pathname)
  } catch {
    return false
  }
}

export function normalizeOpenCodePublicHeaders(headers: Readonly<Record<string, string>>) {
  const result: Record<string, string> = {}
  const metadata = new Set(["client", "project", "request", "session"])
  for (const [key, value] of Object.entries(headers)) {
    const normalized = key.toLowerCase()
    if (normalized === "x-org-id") continue
    if (normalized.startsWith("x-mongolgpt-")) {
      const suffix = normalized.slice("x-mongolgpt-".length)
      if (metadata.has(suffix)) result[`x-opencode-${suffix}`] = value
      continue
    }
    result[key] = value
  }
  return result
}

export function isOpenCodePublicFreeModel(input: {
  readonly id: string
  readonly providerID: string
  readonly api: { readonly url?: string }
  readonly cost?: ModelCost | readonly ModelCost[]
}) {
  return (
    input.providerID === "mongolgpt" &&
    input.id !== "free-auto" &&
    isManagedFreeModel(input) &&
    isOpenCodePublicApi(input.api.url)
  )
}
