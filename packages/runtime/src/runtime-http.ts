export const runtimeHttpHeader = "x-mongolgpt-runtime-native"

// Request signals cannot cross JSRPC without an experimental flag. Use the
// standard DO fetch entrypoint for HTTP; leave SDK process operations on RPC.
export function fetchRuntime(sandbox: { fetch(request: Request): Promise<Response> }, request: Request, port: number) {
  if (port !== 4096) throw new Error("Invalid native runtime port")
  const forwarded = new Request(request)
  forwarded.headers.set(runtimeHttpHeader, "v1")
  return sandbox.fetch(forwarded)
}
