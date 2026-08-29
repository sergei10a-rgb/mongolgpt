import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import {
  hasPlatformAdminPermission,
  PlatformAdminPermissions,
  type PlatformAdminRole,
} from "../../core/src/platform-admin"
import { PlatformAdminRoles, PlatformAdminStatuses } from "../../core/src/schema-d1"
import type { PlatformAdminContext } from "../src/lib/admin-context"
import { platformAdminFromLocals } from "../src/lib/admin-context"
import {
  evaluateExistingPlatformAdmin,
  requirePlatformAdminOwner,
  requirePlatformAdminPermission,
} from "../src/lib/admin-auth"
import { requireAdminUserDetailAccess } from "../src/lib/admin-users"
import { requireAdminWorkspaceInvestigationAccess } from "../src/lib/admin-workspaces"

const routeMatrix = [
  {
    name: "overview",
    allowed: ["owner", "administrator", "support", "finance", "operations"],
    guard: (context: PlatformAdminContext) => requirePlatformAdminPermission(context, "overview.read"),
  },
  {
    name: "users",
    allowed: ["owner", "administrator", "support"],
    guard: (context: PlatformAdminContext) => requirePlatformAdminPermission(context, "users.read"),
  },
  {
    name: "user-detail",
    allowed: ["owner", "administrator"],
    guard: (context: PlatformAdminContext) => requireAdminUserDetailAccess(context),
  },
  {
    name: "workspaces",
    allowed: ["owner", "administrator"],
    guard: (context: PlatformAdminContext) => requireAdminWorkspaceInvestigationAccess(context),
  },
  {
    name: "billing",
    allowed: ["owner", "administrator", "finance"],
    guard: (context: PlatformAdminContext) => requirePlatformAdminPermission(context, "billing.read"),
  },
  {
    name: "plans",
    allowed: ["owner", "administrator"],
    guard: (context: PlatformAdminContext) => requirePlatformAdminPermission(context, "plans.manage"),
  },
  {
    name: "support",
    allowed: ["owner", "administrator", "support"],
    guard: (context: PlatformAdminContext) => requirePlatformAdminPermission(context, "support.read"),
  },
  {
    name: "audit",
    allowed: ["owner", "administrator"],
    guard: (context: PlatformAdminContext) => requirePlatformAdminPermission(context, "audit.read"),
  },
  {
    name: "system-health",
    allowed: ["owner", "administrator", "operations"],
    guard: (context: PlatformAdminContext) => requirePlatformAdminPermission(context, "system.read"),
  },
  {
    name: "operator-admins",
    allowed: ["owner"],
    guard: (context: PlatformAdminContext) => requirePlatformAdminOwner(context),
  },
] as const

const mutationMatrix = [
  { name: "users.suspend", allowed: ["owner", "administrator"] },
  { name: "payments.cancel", allowed: ["owner", "administrator"] },
  { name: "payments.refund", allowed: ["owner", "administrator"] },
  { name: "plans.manage", allowed: ["owner", "administrator"] },
  { name: "support.manage", allowed: ["owner", "administrator", "support"] },
] as const

const source = (path: string) => Bun.file(resolve(import.meta.dir, "..", path)).text()

describe("admin RBAC route matrix", () => {
  test("uses only repo-defined admin roles and statuses", () => {
    expect(PlatformAdminRoles).toEqual(["owner", "administrator", "support", "finance", "operations"])
    expect(PlatformAdminStatuses).toEqual(["active", "suspended"])
  })

  test("fails closed for anonymous, suspended, subject-mismatched, and invalid-role records", () => {
    expect(platformAdminFromLocals({})).toBeUndefined()
    expect(
      platformAdminFromLocals({
        mongolgptPlatformAdmin: {
          ...context("support"),
          permissions: ["system.read"],
        },
      }),
    ).toBeUndefined()
    expect(
      platformAdminFromLocals({
        mongolgptPlatformAdmin: {
          ...context("operations"),
          permissions: [...context("operations").permissions, "users.read"],
        },
      }),
    ).toBeUndefined()
    expect(
      platformAdminFromLocals({
        mongolgptPlatformAdmin: context("finance"),
      }),
    ).toEqual(context("finance"))
    expect(
      evaluateExistingPlatformAdmin(
        {
          status: "suspended",
          role: "owner",
          access_subject: "subject-1",
        },
        "subject-1",
      ),
    ).toMatchObject({ allowed: false, code: "suspended" })
    expect(
      evaluateExistingPlatformAdmin(
        {
          status: "active",
          role: "disabled",
          access_subject: "subject-1",
        },
        "subject-1",
      ),
    ).toMatchObject({ allowed: false, code: "invalid_role" })
    expect(
      evaluateExistingPlatformAdmin(
        {
          status: "active",
          role: "administrator",
          access_subject: "subject-1",
        },
        "subject-2",
      ),
    ).toMatchObject({ allowed: false, code: "subject_mismatch" })
  })

  test("grants each read route only to the intended roles", () => {
    for (const entry of routeMatrix) {
      const allowed = PlatformAdminRoles.filter((role) => canAccess(entry.guard, context(role)))
      expect(allowed, entry.name).toEqual([...entry.allowed])
    }
  })

  test("grants each mutating permission only to the intended roles", () => {
    for (const entry of mutationMatrix) {
      const allowed = PlatformAdminRoles.filter((role) => hasPlatformAdminPermission(role, entry.name))
      expect(allowed, entry.name).toEqual([...entry.allowed])
    }
  })

  test("derives each context permission array from the authoritative grant table", () => {
    for (const role of PlatformAdminRoles) {
      expect(context(role).permissions).toEqual(
        PlatformAdminPermissions.filter((permission) => hasPlatformAdminPermission(role, permission)),
      )
    }
  })

  test("keeps every route wired to a server-side permission guard", async () => {
    const [overview, users, workspaces, billing, support, operators, audit, plans, health] = await Promise.all([
      source("src/routes/index.tsx"),
      source("src/lib/admin-users.ts"),
      source("src/lib/admin-workspaces.ts"),
      source("src/lib/admin-billing.ts"),
      source("src/lib/admin-support.ts"),
      source("src/lib/admin-operators.ts"),
      source("src/lib/admin-audit.ts"),
      source("src/lib/admin-plans.ts"),
      source("src/routes/api/health.ts"),
    ])

    expect(overview).toContain('requirePlatformAdminPermission(getPlatformAdminContext(), "overview.read")')
    expect(users).toContain('const admin = requirePlatformAdminPermission(context, "users.read")')
    expect(users).toContain('const admin = requirePlatformAdminPermission(context, "users.suspend")')
    expect(users).toContain("requireAdminUserDetailAccess")
    expect(workspaces).toContain("requireAdminWorkspaceInvestigationAccess")
    expect(billing).toContain('const admin = requirePlatformAdminPermission(context, "billing.read")')
    expect(billing).toContain('admin = requirePlatformAdminPermission(context, "payments.cancel")')
    expect(billing).toContain('admin = requirePlatformAdminPermission(context, "payments.refund")')
    expect(support).toContain('const admin = requirePlatformAdminPermission(context, "support.read")')
    expect(support).toContain('const admin = requirePlatformAdminPermission(context, "support.manage")')
    expect(operators).toContain("const admin = requirePlatformAdminOwner(context)")
    expect(audit).toContain('const admin = requirePlatformAdminPermission(context, "audit.read")')
    expect(plans).toContain('const admin = requirePlatformAdminPermission(context, "plans.manage")')
    expect(health).toContain('requirePlatformAdminPermission(admin, "system.read")')
    expect(health).not.toContain('hasPlatformAdminPermission(admin.role, "system.read")')
  })
})

function context(role: PlatformAdminRole): PlatformAdminContext {
  return {
    id: "adm_01K3ABCDEFGHJKMNPQRSTVWXYZ",
    email: `${role}@mgpt.mn`,
    subject: `subject-${role}`,
    role,
    permissions: PlatformAdminPermissions.filter((permission) => hasPlatformAdminPermission(role, permission)),
    requestID: "request-1",
    bootstrapped: false,
  }
}

function canAccess(
  guard: (context: PlatformAdminContext) => unknown,
  candidate: PlatformAdminContext,
) {
  try {
    guard(candidate)
    return true
  } catch {
    return false
  }
}
