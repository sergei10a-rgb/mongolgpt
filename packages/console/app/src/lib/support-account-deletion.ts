import { AccountDeletionError } from "@mongolgpt/console-core/account-deletion.js"
import { safeEqual } from "@mongolgpt/console-core/util/crypto.js"
import z from "zod"

const Body = z.object({ email: z.email() })

export async function handleSupportAccountDeletion(
  request: Request,
  service: { secret: string; requestDeletion: (email: string) => Promise<unknown> },
) {
  const json = (body: unknown, status: number) =>
    Response.json(body, { status, headers: { "cache-control": "no-store" } })
  if (!service.secret || !safeEqual(request.headers.get("authorization") ?? "", `Bearer ${service.secret}`))
    return json({ error: "Нэвтрэх эрхгүй байна" }, 401)
  if (request.method !== "DELETE") return json({ error: "Энэ үйлдлийг дэмжихгүй." }, 405)
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json")
    return json({ error: "Хүсэлт буруу байна" }, 400)
  const body = Body.safeParse(await request.json().catch(() => undefined))
  if (!body.success) return json({ error: "Хүсэлт буруу байна" }, 400)
  try {
    const deletion = await service.requestDeletion(body.data.email)
    return json({ success: true, deletion, message: "Бүртгэл устгах хүсэлт бүртгэгдлээ" }, 202)
  } catch (error) {
    const status = error instanceof AccountDeletionError ? (error.code === "not_found" ? 404 : 409) : 503
    return json({ error: "Бүртгэл устгах хүсэлтийг хүлээн авч чадсангүй." }, status)
  }
}
