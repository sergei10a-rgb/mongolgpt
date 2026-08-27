import { describe, expect, test } from "bun:test"
import type { PlatformAdminContext } from "../src/lib/admin-context"
import { type AdminSupportDependencies, mutateAdminSupport } from "../src/lib/admin-support"
import { requirePlatformAdminPermission } from "../src/lib/admin-auth"

const adminID = `adm_${"A".repeat(26)}`
const ticketID = `spt_${"B".repeat(26)}`
const reader: PlatformAdminContext = {
  id: adminID,
  email: "support@mgpt.mn",
  subject: "support",
  role: "support",
  permissions: ["support.read"],
  requestID: "req_1",
  bootstrapped: false,
}
const manager: PlatformAdminContext = { ...reader, permissions: ["support.read", "support.manage"] }

function request(headers: HeadersInit = {}) {
  return new Request("https://admin.mgpt.mn/support", {
    method: "POST",
    headers: { origin: "https://admin.mgpt.mn", "content-type": "application/x-www-form-urlencoded", ...headers },
  })
}

function dependencies(events: string[], audits: unknown[]): AdminSupportDependencies {
  const ticket = { id: ticketID, status: "pending_support", priority: "normal", assigned_admin_id: null }
  return {
    transaction: (async (callback) => callback({} as never)) as AdminSupportDependencies["transaction"],
    getAdminSupportTicketWithDb: (async () => ({ ticket, messages: [] })) as never,
    mutateAdminSupportTicketWithDb: (async (_tx: unknown, input: { operation: string }) => {
      events.push(`mutate:${input.operation}`)
      return { id: ticketID, status: "pending_user", priority: "normal", assignedAdminID: null, lockVersion: 1 }
    }) as never,
    writeAdminAuditWithDb: (async (_tx: unknown, audit: unknown) => {
      events.push("success-audit")
      audits.push(audit)
    }) as never,
    writeAdminAudit: (async (audit: unknown) => {
      events.push("failure-audit")
      audits.push(audit)
    }) as never,
  }
}

describe("admin support mutations", () => {
  test("keeps support.read separate from support.manage", () => {
    expect(() => requirePlatformAdminPermission(reader, "support.read")).not.toThrow()
    expect(() => requirePlatformAdminPermission(reader, "support.manage")).toThrow("эрх хүрэлцэхгүй")
  })

  test("binds the acting admin, mutates and audits atomically without customer message or email metadata", async () => {
    const events: string[] = []
    const audits: unknown[] = []
    const result = await mutateAdminSupport(
      manager,
      request(),
      { operation: "reply", ticketID, expectedLockVersion: "0", message: "api_key=very-secret-value" },
      dependencies(events, audits),
    )
    expect(result).toMatchObject({ ok: true, ticket: { id: ticketID, status: "pending_user" } })
    expect(events).toEqual(["mutate:reply", "success-audit"])
    expect((audits[0] as { adminID: string }).adminID).toBe(adminID)
    const serialized = JSON.stringify((audits[0] as { metadata: unknown }).metadata)
    expect(serialized).not.toContain("very-secret-value")
    expect(serialized).not.toContain("support@mgpt.mn")
  })

  test("denies read-only or cross-origin mutations before the core operation", async () => {
    for (const [context, currentRequest] of [
      [reader, request()],
      [manager, request({ origin: "https://attacker.example" })],
    ] as const) {
      const events: string[] = []
      const audits: unknown[] = []
      const result = await mutateAdminSupport(
        context,
        currentRequest,
        { operation: "note", ticketID, expectedLockVersion: "0", message: "Нууц тэмдэглэл" },
        dependencies(events, audits),
      )
      expect(result).toMatchObject({ ok: false })
      expect(events).toEqual(["failure-audit"])
    }
  })

  test("rejects ambiguous lock versions before mutation", async () => {
    for (const value of ["", "01", "1e2", "-1"]) {
      const events: string[] = []
      const result = await mutateAdminSupport(
        manager,
        request(),
        { operation: "note", ticketID, expectedLockVersion: value, message: "Дотоод тэмдэглэл" },
        dependencies(events, []),
      )
      expect(result).toMatchObject({ ok: false })
      expect(events).toEqual(["failure-audit"])
    }
  })

  test("never reports success when the transaction audit fails", async () => {
    const events: string[] = []
    const audits: unknown[] = []
    const current = dependencies(events, audits)
    current.writeAdminAuditWithDb = (async () => {
      events.push("success-audit")
      throw new Error("audit unavailable")
    }) as AdminSupportDependencies["writeAdminAuditWithDb"]
    const result = await mutateAdminSupport(
      manager,
      request(),
      { operation: "reply", ticketID, expectedLockVersion: "0", message: "Хариу" },
      current,
    )
    expect(result).toMatchObject({ ok: false })
    expect(events).toEqual(["mutate:reply", "success-audit", "failure-audit"])
  })
})
