import type { ServerScope } from "@/utils/server-scope"

const BOOTSTRAP_TIMEOUT_MS = 30_000

export function bootstrapTimeoutMs(scope: ServerScope) {
  try {
    const url = new URL(scope)
    const host = url.hostname.replace(/^\[|\]$/g, "")
    if (url.protocol !== "http:" && url.protocol !== "https:") return BOOTSTRAP_TIMEOUT_MS
    if (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "::1" ||
      host === "::" ||
      host === "0.0.0.0" ||
      /^127\./.test(host)
    ) {
      return BOOTSTRAP_TIMEOUT_MS
    }
    // Hosted admission may need the runtime's full two-minute cold-start budget.
    return 120_000
  } catch {
    return BOOTSTRAP_TIMEOUT_MS
  }
}

export async function bootstrapRequest<T>(
  request: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  timeoutMs = BOOTSTRAP_TIMEOUT_MS,
): Promise<T> {
  signal.throwIfAborted()
  const controller = new AbortController()
  const abort = () => controller.abort(signal.reason)
  signal.addEventListener("abort", abort, { once: true })
  const timer = setTimeout(
    () => controller.abort(new DOMException("Bootstrap request timed out", "TimeoutError")),
    timeoutMs,
  )
  let cancel: () => void = () => {}
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () => reject(controller.signal.reason)
    controller.signal.addEventListener("abort", cancel, { once: true })
  })
  try {
    // Also settle if a platform fetch implementation ignores cancellation.
    return await Promise.race([request(controller.signal), cancelled])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", abort)
    controller.signal.removeEventListener("abort", cancel)
  }
}
