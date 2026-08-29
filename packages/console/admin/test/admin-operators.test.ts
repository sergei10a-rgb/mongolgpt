import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import type { PlatformAdminContext } from "../src/lib/admin-context"
import {
  AdminOperatorMutationInput,
  evaluateAdminOperatorAccessEligibility,
  evaluateAdminOperatorTargetMutation,
} from "../src/lib/admin-operators"
import { requirePlatformAdminOwner } from "../src/lib/admin-auth"

const owner: PlatformAdminContext = {
  id: "adm_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  email: "owner@mgpt.mn",
  subject: "access-owner",
  role: "owner",
  permissions: ["admins.manage"],
  requestID: "req_owner",
  bootstrapped: false,
}

async function source(path: string) {
  return Bun.file(resolve(import.meta.dir, "..", path)).text()
}

describe("platform admin operator management", () => {
  test("normalizes new operator email and limits roles to non-owner roles", () => {
    expect(
      AdminOperatorMutationInput.parse({
        operation: "create",
        email: " Support@MGPT.MN ",
        role: "support",
      }),
    ).toMatchObject({ email: "support@mgpt.mn", role: "support" })
    expect(
      AdminOperatorMutationInput.safeParse({
        operation: "create",
        email: "operator@mgpt.mn",
        role: "owner",
      }).success,
    ).toBe(false)
    expect(
      AdminOperatorMutationInput.safeParse({
        operation: "create",
        email: "not-an-email",
        role: "support",
      }).success,
    ).toBe(false)
  })

  test("requires an owner even if a non-owner context claims admins.manage", () => {
    expect(() => requirePlatformAdminOwner(owner)).not.toThrow()
    expect(() => requirePlatformAdminOwner({ ...owner, role: "administrator" })).toThrow("эзэмшигч")
  })

  test("protects self and every owner target from changes", () => {
    expect(evaluateAdminOperatorTargetMutation(owner.id, { id: owner.id, role: "owner" })).toBe("self_change")
    expect(evaluateAdminOperatorTargetMutation(owner.id, { id: "adm_other", role: "owner" })).toBe("owner_protected")
    expect(evaluateAdminOperatorTargetMutation(owner.id, { id: "adm_operator", role: "support" })).toBeUndefined()
  })

  test("only creates or reactivates operators already allowed by Cloudflare Access", () => {
    const accessEmails = new Set(["owner@mgpt.mn", "support@mgpt.mn"])

    expect(evaluateAdminOperatorAccessEligibility("support@mgpt.mn", accessEmails)).toBeUndefined()
    expect(evaluateAdminOperatorAccessEligibility("finance@mgpt.mn", accessEmails)).toBe("access_not_allowed")
  })

  test("keeps mutation security, transaction, and audit in the server contract", async () => {
    const operators = await source("src/lib/admin-operators.ts")
    const route = await source("src/routes/admins/index.tsx")

    expect(operators).toContain('requireSameOriginAdminMutation(request)')
    expect(operators).toContain("requirePlatformAdminOwner(context)")
    expect(operators).toContain("Database.transaction(async (tx) =>")
    expect(operators).toContain("requireActiveOwner(tx, admin)")
    expect(operators).toContain("writeAdminAuditWithDb(tx")
    expect(operators).toContain("writeAdminAudit({")
    expect(operators).toContain("resultChanges(updated) !== 1")
    expect(operators).toContain('AdminOperatorMutationError("conflict")')
    expect(operators).toContain("loadAdminAccessConfig().bootstrapEmails")
    expect(operators).toContain('input.operation === "reactivate"')
    expect(operators).toContain('AdminOperatorMutationError(accessError)')
    expect(operators).toContain('"owner_protected"')
    expect(operators).toContain('"self_change"')
    expect(route).toContain("Операторын удирдлага")
    expect(route).toContain("Cloudflare Access ба дотоод эрх")
    expect(route).toContain("operator.accessAllowed")
    expect(route).toContain("aria-live")
    expect(route).not.toContain("opencode")
  })
})
