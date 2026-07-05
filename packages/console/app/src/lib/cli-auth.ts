import { createClient } from "@openauthjs/openauth/client"
import { createSubjects } from "@openauthjs/openauth/subject"
import { Resource } from "@mongolgpt/console-resource"
import { z } from "zod"

const subjects = createSubjects({
  account: z.object({
    accountID: z.string(),
    email: z.string(),
    newAccount: z.boolean().optional(),
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
}

export async function verifyCliAccount(request: Request): Promise<{ account: CliAccount } | { response: Response }> {
  const header = request.headers.get("authorization")
  const token = header?.match(/^Bearer\s+(.+)$/i)?.[1]
  if (!token) return { response: unauthorized("Bearer token алга") }

  const verified = await authClient.verify(token)
  if ("err" in verified) return { response: unauthorized("Bearer token буруу байна") }
  if (verified.subject.type !== "account") return { response: unauthorized("Account token шаардлагатай") }

  return {
    account: {
      accountID: verified.subject.properties.accountID,
      email: verified.subject.properties.email,
    },
  }
}

function unauthorized(message: string) {
  return Response.json({ error: "unauthorized", message }, { status: 401 })
}
