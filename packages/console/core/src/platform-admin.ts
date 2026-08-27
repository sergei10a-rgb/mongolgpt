import { PlatformAdminRoles } from "./schema/admin.sql"

export const PlatformAdminPermissions = [
  "admin.access",
  "overview.read",
  "users.read",
  "billing.read",
  "system.read",
  "audit.read",
  "admins.manage",
  "users.suspend",
  "payments.refund",
  "payments.cancel",
  "plans.manage",
  "support.read",
  "support.manage",
] as const

export type PlatformAdminRole = (typeof PlatformAdminRoles)[number]
export type PlatformAdminPermission = (typeof PlatformAdminPermissions)[number]

// Owners are bootstrap-controlled and can never be assigned through the operator UI.
export const PlatformAdminAssignableRoles = ["administrator", "support", "finance", "operations"] as const
export type PlatformAdminAssignableRole = (typeof PlatformAdminAssignableRoles)[number]

const grants: Record<PlatformAdminRole, ReadonlySet<PlatformAdminPermission>> = {
  owner: new Set(PlatformAdminPermissions),
  administrator: new Set([
    "admin.access",
    "overview.read",
    "users.read",
    "billing.read",
    "system.read",
    "audit.read",
    "users.suspend",
    "payments.refund",
    "payments.cancel",
    "plans.manage",
    "support.read",
    "support.manage",
  ]),
  support: new Set(["admin.access", "overview.read", "users.read", "support.read", "support.manage"]),
  finance: new Set(["admin.access", "overview.read", "billing.read"]),
  operations: new Set(["admin.access", "overview.read", "system.read"]),
}

export function isPlatformAdminRole(value: unknown): value is PlatformAdminRole {
  return typeof value === "string" && PlatformAdminRoles.some((role) => role === value)
}

export function isPlatformAdminAssignableRole(value: unknown): value is PlatformAdminAssignableRole {
  return typeof value === "string" && PlatformAdminAssignableRoles.some((role) => role === value)
}

export function hasPlatformAdminPermission(role: PlatformAdminRole, permission: PlatformAdminPermission) {
  return grants[role].has(permission)
}

export function normalizePlatformAdminEmail(value: string) {
  const email = value.trim().toLowerCase()
  if (email.length < 3 || email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error("Админы имэйл хаяг буруу байна.")
  }
  return email
}
