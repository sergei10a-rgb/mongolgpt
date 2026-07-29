import { AccountAccessPolicy } from "@mongolgpt/console-core/account-access-policy.js"

type Credential = {
  id: string
  email: string
  authVersion?: number
}

export function resolveSessionAccess(input: {
  accounts: Record<string, Credential>
  current?: string
  blocked?: "suspended"
  records: AccountAccessPolicy.Record[]
}) {
  const entries = Object.entries(input.accounts)
  if (entries.length === 0) {
    return {
      accounts: input.accounts,
      current: undefined,
      blocked: input.blocked,
      suspended: input.blocked === "suspended",
    }
  }

  const byID = new Map(input.records.map((record) => [record.id, record]))
  const resolved = entries.map(([id, credential]) => ({
    id,
    credential,
    decision: AccountAccessPolicy.evaluate(byID.get(id), credential.authVersion ?? 0),
  }))
  const accounts = Object.fromEntries(
    resolved.flatMap((entry) => (entry.decision.allowed ? [[entry.id, entry.credential] as const] : [])),
  )
  const current = input.current && accounts[input.current] ? input.current : Object.keys(accounts)[0]
  const suspended = resolved.some((entry) => !entry.decision.allowed && entry.decision.reason === "suspended")
  return {
    accounts,
    current,
    blocked: Object.keys(accounts).length === 0 && suspended ? ("suspended" as const) : undefined,
    suspended,
  }
}
