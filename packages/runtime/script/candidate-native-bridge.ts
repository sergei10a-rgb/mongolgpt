import candidate from "../wrangler.candidate.dev.json"

type Env = {
  CANDIDATE: { fetch(request: Request): Promise<Response> }
  PROBE_KEY: string
  PROBE_TOKEN: string
  PROBE_SESSION: string
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url)
    if (request.headers.get("x-probe-key") !== env.PROBE_KEY || !env.PROBE_KEY)
      return new Response(null, { status: 403 })
    if (
      url.pathname !== "/api/session" ||
      url.search ||
      !["GET", "POST"].includes(request.method) ||
      request.headers.has("origin") ||
      !/^ses_candidate_[0-9]{1,12}_[0-9]{1,3}$/.test(env.PROBE_SESSION)
    )
      return new Response(null, { status: 400 })
    // The caller cannot choose an account, destination, model, tool, or arbitrary request body.
    return env.CANDIDATE.fetch(
      new Request("https://candidate.invalid/api/session?location%5Bdirectory%5D=%2Fworkspace", {
        method: request.method,
        headers: {
          origin: candidate.vars.MONGOLGPT_APP_ORIGIN,
          authorization: `Bearer ${env.PROBE_TOKEN}`,
          "content-type": "application/json",
        },
        body:
          request.method === "POST"
            ? JSON.stringify({ id: env.PROBE_SESSION, location: { directory: "/workspace" } })
            : undefined,
        redirect: "manual",
      }),
    )
  },
}
