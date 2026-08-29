import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"

describe("OAuth account provisioning contract", () => {
  test("gives a first-time account an active workspace without requiring a paid plan", async () => {
    const source = await Bun.file(resolve(import.meta.dir, "../src/auth.ts")).text()

    expect(source).toContain("await User.joinInvitedWorkspaces()")
    expect(source).toContain("eq(UserTable.accountID, accountID)")
    expect(source).toContain("isNull(UserTable.timeDeleted)")
    expect(source).toContain("isNull(WorkspaceTable.timeDeleted)")
    expect(source).toContain('await Workspace.create({ name: "Миний орчин" })')
    expect(source).not.toContain('Workspace.create({ name: "Default" })')
  })

  test("delegates account identity writes to the D1 batch provisioner", async () => {
    const source = await Bun.file(resolve(import.meta.dir, "../src/auth.ts")).text()

    expect(source).toContain('from "@mongolgpt/console-core/oauth-account-provisioning.js"')
    expect(source).toContain("await provisionOAuthAccountIdentity({")
    expect(source).not.toContain("await Account.create({")
  })
})
