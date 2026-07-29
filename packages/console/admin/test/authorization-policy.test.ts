import { describe, expect, test } from "bun:test"
import {
  canBootstrapFirstOwner,
  evaluateExistingPlatformAdmin,
} from "../src/lib/admin-auth"

describe("platform admin authorization policy", () => {
  test("bootstraps only the first explicitly allowed owner", () => {
    const bootstrap = new Set(["owner@mgpt.mn"])

    expect(canBootstrapFirstOwner(0, bootstrap, "owner@mgpt.mn")).toBe(true)
    expect(canBootstrapFirstOwner(1, bootstrap, "owner@mgpt.mn")).toBe(false)
    expect(canBootstrapFirstOwner(0, bootstrap, "other@mgpt.mn")).toBe(false)
  })

  test("binds the first verified subject and accepts the same subject later", () => {
    expect(
      evaluateExistingPlatformAdmin(
        {
          status: "active",
          role: "support",
          access_subject: null,
        },
        "subject-1",
      ),
    ).toEqual({
      allowed: true,
      role: "support",
      bindSubject: true,
    })
    expect(
      evaluateExistingPlatformAdmin(
        {
          status: "active",
          role: "support",
          access_subject: "subject-1",
        },
        "subject-1",
      ),
    ).toEqual({
      allowed: true,
      role: "support",
      bindSubject: false,
    })
  })

  test("denies suspended, invalid-role, and mismatched-subject records", () => {
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
          role: "member",
          access_subject: "subject-1",
        },
        "subject-1",
      ),
    ).toMatchObject({ allowed: false, code: "invalid_role" })
    expect(
      evaluateExistingPlatformAdmin(
        {
          status: "active",
          role: "owner",
          access_subject: "subject-1",
        },
        "subject-2",
      ),
    ).toMatchObject({ allowed: false, code: "subject_mismatch" })
  })
})
