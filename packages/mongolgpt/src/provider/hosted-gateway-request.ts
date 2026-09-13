import { HostedCredential } from "@mongolgpt/core/hosted-credential"

export function hostedGatewayRequest(input: RequestInfo | URL, init: RequestInit | undefined, consoleUrl: string) {
  const target = new URL(input instanceof Request ? input.url : input)
  const console = new URL(consoleUrl)
  if (
    console.protocol !== "https:" ||
    target.origin !== console.origin ||
    target.username ||
    target.password ||
    target.hash ||
    !target.pathname.startsWith("/gateway/v1/")
  ) {
    throw new Error("Cloud нэвтрэх мэдээллийг энэ хаяг руу дамжуулахыг зөвшөөрөхгүй.")
  }
  // SDK instances are cached, but the request-scoped gateway capability expires quickly.
  const token = HostedCredential.resolve(HostedCredential.EnvironmentName, HostedCredential.Placeholder)
  if (!token) throw new Error("Cloud нэвтрэх сессийн хугацаа дууссан байна. Хуудсаа дахин ачаална уу.")
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
  headers.set("authorization", `Bearer ${token}`)
  for (const key of ["x-api-key", "x-goog-api-key"]) {
    if (headers.has(key)) headers.set(key, token)
  }
  return { ...init, headers, redirect: "error" as const }
}
