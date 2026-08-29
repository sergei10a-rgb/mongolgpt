import { getRequestEvent } from "solid-js/web"
import type {
  PlatformAdminPermission,
  PlatformAdminRole,
} from "@mongolgpt/console-core/platform-admin.js"
import {
  hasPlatformAdminPermission,
  isPlatformAdminRole,
  PlatformAdminPermissions,
} from "@mongolgpt/console-core/platform-admin.js"

const contextKey = "mongolgptPlatformAdmin"

export interface PlatformAdminContext {
  id: string
  email: string
  subject: string
  role: PlatformAdminRole
  permissions: PlatformAdminPermission[]
  requestID: string
  bootstrapped: boolean
}

export function setPlatformAdminContext(locals: Record<string, unknown>, context: PlatformAdminContext) {
  locals[contextKey] = context
}

export function platformAdminFromLocals(locals: Record<string, unknown>) {
  const value = locals[contextKey]
  if (!isPlatformAdminContext(value)) return undefined
  return value
}

export function getPlatformAdminContext() {
  "use server"
  const event = getRequestEvent()
  if (!event) throw new Error("Админы хүсэлтийн орчин олдсонгүй.")
  const context = platformAdminFromLocals(event.locals)
  if (!context) throw new Error("Админы баталгаажсан эрх олдсонгүй.")
  return context
}

function isPlatformAdminContext(value: unknown): value is PlatformAdminContext {
  if (typeof value !== "object" || value === null) return false
  if (!("id" in value) || typeof value.id !== "string") return false
  if (!("email" in value) || typeof value.email !== "string") return false
  if (!("subject" in value) || typeof value.subject !== "string") return false
  const role = "role" in value ? value.role : undefined
  if (!isPlatformAdminRole(role)) return false
  const permissions = "permissions" in value ? value.permissions : undefined
  if (!Array.isArray(permissions)) return false
  const expected = PlatformAdminPermissions.filter((permission) => hasPlatformAdminPermission(role, permission))
  if (permissions.length !== expected.length || !expected.every((permission) => permissions.includes(permission))) {
    return false
  }
  if (!("requestID" in value) || typeof value.requestID !== "string") return false
  return "bootstrapped" in value && typeof value.bootstrapped === "boolean"
}
