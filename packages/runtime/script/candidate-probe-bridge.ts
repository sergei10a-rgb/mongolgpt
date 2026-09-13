export default {
  fetch(request: Request, env: { CANDIDATE: { fetch(input: string, init: RequestInit): Promise<Response> } }) {
    const path = new URL(request.url).pathname
    const origin = request.headers.get("origin")
    const authorization = request.headers.get("authorization")
    if (
      request.method !== "GET" ||
      !["/global/health", "/session"].includes(path) ||
      (origin !== null && origin !== "https://app.dev.mgpt.mn") ||
      (authorization !== null && authorization !== "Bearer invalid")
    )
      return new Response(null, { status: 400 })
    const headers: Record<string, string> = {}
    if (origin) headers.origin = origin
    if (authorization) headers.authorization = authorization
    // This workerd version supports manual, not error; the caller rejects all redirect responses.
    return env.CANDIDATE.fetch(`https://candidate.invalid${path}`, { method: "GET", headers, redirect: "manual" })
  },
}
