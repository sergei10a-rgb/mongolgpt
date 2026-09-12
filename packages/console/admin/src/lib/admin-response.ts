import { getRequestEvent } from "solid-js/web"

export const adminResponseError = "Үйлдлийн үр дүнг баталгаажуулж чадсангүй. Хуудсаа шинэчилж шалгана уу."

export function adminActionFeedback(result: unknown, error?: unknown) {
  if (result === undefined && error === undefined) return
  if (
    error === undefined &&
    result !== null &&
    typeof result === "object" &&
    "ok" in result &&
    typeof result.ok === "boolean" &&
    "message" in result &&
    typeof result.message === "string" &&
    result.message.trim()
  )
    return { ok: result.ok, message: result.message }
  return { ok: false, message: adminResponseError }
}

// SolidStart's default RPC stream evaluates JavaScript, which our admin CSP forbids.
// SSR keeps native values; browser calls use its raw JSON response contract instead.
export async function adminResponse<T>(read: () => Promise<T>): Promise<T | Response> {
  const request = getRequestEvent()?.request
  if (!request || new URL(request.url).pathname !== "/_server") return read()
  try {
    return Response.json(await read(), { headers: { "X-Content-Raw": "true" } })
  } catch {
    return Response.json(
      { message: adminResponseError },
      { status: 500, headers: { "X-Content-Raw": "true", "X-Error": "true" } },
    )
  }
}
