const forwardedRequestHeaders = ["accept", "content-type", "anthropic-version", "anthropic-beta"]

export function sanitizeProviderRequestHeaders(input: Headers) {
  return new Headers(
    forwardedRequestHeaders.flatMap((name) => {
      const value = input.get(name)
      return value ? [[name, value]] : []
    }),
  )
}

export function authenticatedRateLimitIdentity(
  account: { workspaceID: string; userID: string } | undefined,
  credential: string | undefined,
) {
  if (account) return `workspace:${account.workspaceID}:user:${account.userID}`
  return credential
}
