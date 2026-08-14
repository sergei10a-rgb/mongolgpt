import { createClient } from "@openauthjs/openauth/client"
import { createSubjects } from "@openauthjs/openauth/subject"
import { Resource } from "@mongolgpt/console-resource"
import { AccountAccess } from "@mongolgpt/console-core/account-access.js"
import { z } from "zod"

const subjects = createSubjects({
  account: z.object({
    accountID: z.string(),
    email: z.string(),
    newAccount: z.boolean().optional(),
    authVersion: z.number().int().nonnegative().optional(),
  }),
  user: z.object({
    userID: z.string(),
    workspaceID: z.string(),
  }),
})

const authClient = createClient({
  clientID: "mongolgpt-cli",
  issuer: Resource.AUTH_API_URL.value,
  subjects,
})

export type CliAccount = {
  accountID: string
  email: string
  authVersion: number
}

export async function verifyCliToken(token: string): Promise<CliAccount | undefined> {
  const verified = await authClient.verify(token).catch(() => undefined)
  if (!verified || "err" in verified || verified.subject.type !== "account") return undefined
  const authVersion = verified.subject.properties.authVersion ?? 0
  const access = await AccountAccess.verify({
    accountID: verified.subject.properties.accountID,
    authVersion,
  })
  if (!access.allowed) return undefined
  return {
    accountID: verified.subject.properties.accountID,
    email: verified.subject.properties.email,
    authVersion,
  }
}

export async function verifyCliAccount(request: Request): Promise<{ account: CliAccount } | { response: Response }> {
  const header = request.headers.get("authorization")
  const token = header?.match(/^Bearer\s+(.+)$/i)?.[1]
  if (!token) return { response: unauthorized("Нэвтрэх токен олдсонгүй") }

  const account = await verifyCliToken(token)
  if (!account) return { response: unauthorized("Аккаунтын токен буруу эсвэл хүчингүй болсон байна") }
  return { account }
}

function unauthorized(message: string) {
  return Response.json({ error: "unauthorized", message }, { status: 401 })
}
