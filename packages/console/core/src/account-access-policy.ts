import { z } from "zod"
import { Identifier } from "./identifier"
import { AccountStatuses } from "./schema/account.sql"

export namespace AccountAccessPolicy {
  export const Reason = z
    .string()
    .trim()
    .min(10)
    .max(500)
    .refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))
    .transform((value) => value.replace(/\s+/g, " "))

  export const Transition = z.object({
    accountID: Identifier.schema("account").max(30),
    adminID: z.string().startsWith("adm_").max(30),
    status: z.enum(AccountStatuses),
    reason: Reason,
  })

  export type Status = (typeof AccountStatuses)[number]
  export type Transition = z.infer<typeof Transition>

  export type Record = {
    id: string
    status: Status
    auth_version: number
    timeDeleted: Date | null
  }

  export type Decision =
    | { allowed: true; accountID: string; authVersion: number }
    | { allowed: false; reason: "missing" | "suspended" | "revoked" }

  export function evaluate(record: Record | undefined, authVersion?: number): Decision {
    if (!record || record.timeDeleted) return { allowed: false, reason: "missing" }
    if (record.status !== "active") return { allowed: false, reason: "suspended" }
    if (authVersion !== undefined && record.auth_version !== authVersion) {
      return { allowed: false, reason: "revoked" }
    }
    return {
      allowed: true,
      accountID: record.id,
      authVersion: record.auth_version,
    }
  }
}
