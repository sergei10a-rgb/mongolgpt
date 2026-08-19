import { currentAuthAccount, type AuthAccount } from "../../auth/helpers"
import type { AccountOverviewIdentity } from "./overview-handler"

type Session = {
  data: {
    account?: Record<string, AuthAccount>
    current?: string
  }
  suspended: boolean
}

export async function resolveAccountOverviewIdentity(
  request: Request,
  input: {
    verifyToken: (token: string) => Promise<{ accountID: string; email: string } | undefined>
    session: () => Promise<Session>
  },
): Promise<AccountOverviewIdentity> {
  const authorization = request.headers.get("authorization")
  if (authorization) {
    const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1]
    if (!token) return { status: "unauthorized" }
    const account = await input.verifyToken(token)
    if (!account) return { status: "unauthorized" }
    return { status: "authenticated", account: { id: account.accountID, email: account.email } }
  }

  const session = await input.session()
  const account = currentAuthAccount(session)
  if (account) return { status: "authenticated", account }
  if (session.suspended) return { status: "suspended" }
  return { status: "unauthorized" }
}
