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
  "plans.manage",
] as const

export type PlatformAdminRole = (typeof PlatformAdminRoles)[number]
export type PlatformAdminPermission = (typeof PlatformAdminPermissions)[number]

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
    "plans.manage",
  ]),
  support: new Set(["admin.access", "overview.read", "users.read"]),
  finance: new Set(["admin.access", "overview.read", "billing.read"]),
  operations: new Set(["admin.access", "overview.read", "system.read"]),
}

export function isPlatformAdminRole(value: unknown): value is PlatformAdminRole {
  return typeof value === "string" && PlatformAdminRoles.some((role) => role === value)
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
