import { getRequestEvent } from "solid-js/web"

export const adminResponseError = "Үйлдлийн үр дүнг баталгаажуулж чадсангүй. Хуудсаа шинэчилж шалгана уу."

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
