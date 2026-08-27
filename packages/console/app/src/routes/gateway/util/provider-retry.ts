const MAX_INLINE_RETRY_DELAY_MS = 2_000

export type ProviderFailoverRetry = {
  excludeProviders: string[]
  retryCount: number
}

type ProviderFailoverPolicy = {
  maxRetries: number
  stickyProvider: "strict" | "prefer" | undefined
  fallbackProvider: string | undefined
  currentProvider: string
}

export function canFailoverProvider(input: {
  retryCount: number
  maxRetries: number
  stickyProvider: "strict" | "prefer" | undefined
  fallbackProvider: string | undefined
  currentProvider: string
}) {
  return (
    input.retryCount < input.maxRetries &&
    input.stickyProvider !== "strict" &&
    !!input.fallbackProvider &&
    input.currentProvider !== input.fallbackProvider
  )
}

export function nextProviderFailoverRetry(input: { retry: ProviderFailoverRetry; policy: ProviderFailoverPolicy }) {
  if (!canFailoverProvider({ retryCount: input.retry.retryCount, ...input.policy })) return undefined
  return {
    excludeProviders: [...new Set([...input.retry.excludeProviders, input.policy.currentProvider])],
    retryCount: input.retry.retryCount + 1,
  } satisfies ProviderFailoverRetry
}

export function shouldFailoverProviderStatus(status: number) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599)
}

export async function cancelProviderResponse(response: Response) {
  if (response.body) await response.body.cancel().catch(() => undefined)
}

export async function runProviderAttempt<T>(input: {
  retry: ProviderFailoverRetry
  policy: ProviderFailoverPolicy
  request: () => Promise<Response>
  onNetworkError?: (error: unknown) => void | Promise<void>
  onResponse?: (response: Response) => void | Promise<void>
  failover: (retry: ProviderFailoverRetry) => Promise<T>
  complete: (response: Response) => T | Promise<T>
}): Promise<T> {
  let response: Response
  try {
    response = await input.request()
  } catch (error) {
    await input.onNetworkError?.(error)
    const next = nextProviderFailoverRetry(input)
    if (next) return input.failover(next)
    throw error
  }

  await input.onResponse?.(response)
  if (shouldFailoverProviderStatus(response.status)) {
    const next = nextProviderFailoverRetry(input)
    if (next) {
      await cancelProviderResponse(response)
      return input.failover(next)
    }
  }
  return input.complete(response)
}

export function inlineProviderRetryDelayMs(
  value: string | null,
  attempt: number,
  now = Date.now(),
): number | undefined {
  const fallback = Math.min(MAX_INLINE_RETRY_DELAY_MS, 500 * 2 ** Math.max(0, attempt))
  const retryAfter = value?.trim()
  if (!retryAfter) return fallback

  const seconds = Number(retryAfter)
  const delay = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : Date.parse(retryAfter) - now
  if (!Number.isFinite(delay) || delay < 0) return fallback
  if (delay > MAX_INLINE_RETRY_DELAY_MS) return undefined
  return Math.ceil(delay)
}
