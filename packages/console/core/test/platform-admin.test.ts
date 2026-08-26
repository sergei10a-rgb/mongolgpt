import { describe, expect, test } from "bun:test"
import {
  hasPlatformAdminPermission,
  isPlatformAdminAssignableRole,
  isPlatformAdminRole,
  normalizePlatformAdminEmail,
} from "../src/platform-admin"

describe("platform admin RBAC", () => {
  test("keeps owner-only administrator management and cancellation permissions separate", () => {
    expect(hasPlatformAdminPermission("owner", "admins.manage")).toBe(true)
    expect(hasPlatformAdminPermission("administrator", "admins.manage")).toBe(false)
    expect(hasPlatformAdminPermission("owner", "payments.cancel")).toBe(true)
    expect(hasPlatformAdminPermission("administrator", "payments.cancel")).toBe(true)
    expect(hasPlatformAdminPermission("finance", "payments.cancel")).toBe(false)
    expect(hasPlatformAdminPermission("support", "payments.cancel")).toBe(false)
    expect(hasPlatformAdminPermission("operations", "payments.cancel")).toBe(false)
    expect(hasPlatformAdminPermission("support", "billing.read")).toBe(false)
    expect(hasPlatformAdminPermission("finance", "billing.read")).toBe(true)
    expect(hasPlatformAdminPermission("operations", "system.read")).toBe(true)
  })

  test("recognizes only declared platform roles", () => {
    expect(isPlatformAdminRole("owner")).toBe(true)
    expect(isPlatformAdminRole("admin")).toBe(false)
    expect(isPlatformAdminRole("member")).toBe(false)
  })

  test("allows the operator UI to assign only non-owner roles", () => {
    expect(isPlatformAdminAssignableRole("administrator")).toBe(true)
    expect(isPlatformAdminAssignableRole("support")).toBe(true)
    expect(isPlatformAdminAssignableRole("owner")).toBe(false)
    expect(isPlatformAdminAssignableRole("member")).toBe(false)
  })

  test("normalizes administrator email addresses", () => {
    expect(normalizePlatformAdminEmail(" Owner@MGPT.MN ")).toBe("owner@mgpt.mn")
    expect(() => normalizePlatformAdminEmail("not-an-email")).toThrow("имэйл")
    expect(() => normalizePlatformAdminEmail("owner@localhost")).toThrow("имэйл")
  })
})
