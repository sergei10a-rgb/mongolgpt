const CONFIRM_DELETE = "УСТГАХ"
const CONFIRM_CANCEL = "ЦУЦЛАХ"

export interface AccountDeletionIdentity {
  accountID: string
  email: string
}

export interface AccountDeletionService {
  requestAccountDeletion(input: { accountID: string }): Promise<unknown>
  cancelAccountDeletion(input: { accountID: string }): Promise<unknown>
  getAccountDeletion(input: { accountID: string }): Promise<unknown>
}

export interface AccountDeletionHandlerInput {
  request: Request
  identity?: AccountDeletionIdentity
  service: AccountDeletionService
}

const responseHeaders = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
} as const

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: responseHeaders })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isSameOrigin(request: Request) {
  const origin = request.headers.get("origin")
  if (!origin) return false
  try {
    return origin === new URL(request.url).origin
  } catch {
    return false
  }
}

async function readJson(request: Request) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return undefined
  try {
    return await request.json()
  } catch {
    return undefined
  }
}

function coreErrorStatus(error: unknown) {
  if (!isRecord(error)) return 500
  if (error.status === 404 || error.status === 409) return error.status
  const code = typeof error.code === "string" ? error.code.toLowerCase() : ""
  const name = typeof error.name === "string" ? error.name.toLowerCase() : ""
  if (code === "not_found" || code === "account_not_found" || name === "accountdeletionnotfounderror") return 404
  if (
    code === "too_late" ||
    code === "deletion_conflict" ||
    code === "workspace_admin_required" ||
    name === "accountdeletionconflicterror"
  ) {
    return 409
  }
  return 500
}

function errorMessage(error: unknown, status: number) {
  if (status === 404) return "Устгах хүсэлттэй холбоотой аккаунт олдсонгүй."
  if (isRecord(error) && error.code === "workspace_admin_required") {
    return "Хуваалцсан ажлын талбарт өөр админ томилсны дараа аккаунтаа устгана уу."
  }
  if (status === 409) return "Аккаунтыг устгах хүсэлтийн төлөв энэ үйлдэлтэй зөрчилдөж байна."
  return "Серверийн алдаа гарлаа."
}

export async function handleAccountDeletion({ request, identity, service }: AccountDeletionHandlerInput) {
  if (!identity?.accountID || !identity.email) return json({ error: "Нэвтэрч орно уу." }, 401)
  if (request.method !== "GET" && !isSameOrigin(request)) {
    return json({ error: "Хүсэлтийн гарал үүсэл зөвшөөрөгдөөгүй." }, 403)
  }

  try {
    if (request.method === "GET") {
      const deletion = await service.getAccountDeletion({ accountID: identity.accountID })
      return json({ success: true, account: { email: identity.email }, deletion: deletion ?? null })
    }

    if (request.method === "POST") {
      const body = await readJson(request)
      if (!isRecord(body)) {
        return json({ error: "Имэйл болон ‘УСТГАХ’ баталгаажуулалтыг зөв оруулна уу." }, 400)
      }
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : ""
      if (body.confirmation !== CONFIRM_DELETE || email !== identity.email.trim().toLowerCase()) {
        return json({ error: "Имэйл болон ‘УСТГАХ’ баталгаажуулалтыг зөв оруулна уу." }, 400)
      }
      const deletion = await service.requestAccountDeletion({ accountID: identity.accountID })
      return json({ success: true, deletion }, 202)
    }

    if (request.method === "DELETE") {
      const body = await readJson(request)
      if (!isRecord(body) || body.confirmation !== CONFIRM_CANCEL) {
        return json({ error: "‘ЦУЦЛАХ’ баталгаажуулалтыг зөв оруулна уу." }, 400)
      }
      const deletion = await service.cancelAccountDeletion({ accountID: identity.accountID })
      return json({ success: true, deletion })
    }

    return json({ error: "Энэ үйлдлийг дэмжихгүй." }, 405)
  } catch (error) {
    const status = coreErrorStatus(error)
    return json({ error: errorMessage(error, status) }, status)
  }
}
