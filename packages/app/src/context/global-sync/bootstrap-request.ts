const BOOTSTRAP_TIMEOUT_MS = 30_000

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
