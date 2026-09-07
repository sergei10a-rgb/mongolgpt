import { accountRuntimeToken } from "../../lib/runtime-token"
import { canonicalHttpsOrigin } from "../auth/helpers"

export async function nativeRuntimeTokenRequest(
  request: Request,
  input: {
    runtimeUrl: string | undefined
    secret: string
    authenticate: (request: Request) => Promise<{ id: string; email: string; authVersion: number } | undefined>
    workspaces: (accountID: string) => Promise<readonly { id: string; name: string }[]>
    now?: () => number
  },
) {
  const headers = new Headers({ "Cache-Control": "no-store", Vary: "Origin" })
  if (request.method !== "POST") {
    headers.set("Allow", "POST")
    return Response.json({ error: "method_not_allowed", message: "POST хүсэлт илгээнэ үү." }, { status: 405, headers })
  }
  // Browser cookie sessions retain their separate, exact-origin CSRF boundary.
  if (request.headers.has("origin")) {
    return Response.json(
      { error: "invalid_origin", message: "Энэ замд CLI бүртгэлийн токеноор хандана уу." },
      { status: 403, headers },
    )
  }
  if (!/^Bearer [^\s,]+$/i.test(request.headers.get("authorization") ?? "")) {
    return unauthorized(headers)
  }
  const account = await input.authenticate(request)
  if (!account) return unauthorized(headers)
  const audience = canonicalHttpsOrigin(input.runtimeUrl)
  if (!audience) {
    return Response.json(
      { error: "runtime_not_configured", message: "MongolGPT runtime серверийн хаяг тохируулагдаагүй байна." },
      { status: 500, headers },
    )
  }
  return accountRuntimeToken(request, { ...input, account, audience }, headers)
}

function unauthorized(headers: Headers) {
  return Response.json(
    { error: "unauthorized", message: "MongolGPT бүртгэлээр дахин нэвтэрнэ үү." },
    { status: 401, headers },
  )
}
