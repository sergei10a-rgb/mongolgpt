const publicProxyHeaderNames = [
  "accept",
  "cache-control",
  "content-type",
  "if-match",
  "if-modified-since",
  "if-none-match",
  "if-range",
  "if-unmodified-since",
  "range",
] as const

export function publicProxyRequestHeaders(input: Headers) {
  const output = new Headers()
  for (const name of publicProxyHeaderNames) {
    const value = input.get(name)
    if (value !== null) output.set(name, value)
  }
  return output
}
