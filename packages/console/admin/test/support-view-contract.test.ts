import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"

const source = (path: string) => Bun.file(resolve(import.meta.dir, path)).text()

describe("admin support view contract", () => {
  test("shows the Mongolian support navigation only for support.read", async () => {
    const header = await source("../src/component/admin-header.tsx")
    expect(header).toContain('props.admin.permissions.includes("support.read")')
    expect(header).toContain('href="/support"')
    expect(header).toContain("Тусламж")
  })

  test("keeps queue filters and stable cursor navigation wired to the real query", async () => {
    const view = await source("../src/routes/support/index.tsx")
    expect(view).toContain("listAdminSupportQueue")
    expect(view).toContain("status: isStatus(input.status) ? input.status : undefined")
    expect(view).toContain("priority: isPriority(input.priority) ? input.priority : undefined")
    expect(view).toContain("assignment: isAssignment(input.assignment) ? input.assignment : undefined")
    expect(view).toContain("accountID: input.accountID?.trim() || undefined")
    expect(view).toContain("nextCursor")
    expect(view).toContain("Оноогоогүй")
  })

  test("keeps read-only admins out of every mutation control", async () => {
    const view = await source("../src/routes/support/[ticketID].tsx")
    expect(view).toContain("const [detail, assignableAdmins] = await Promise.all")
    expect(view).toContain('canManage: context.permissions.includes("support.manage")')
    expect(view).toContain("<Show when={data().canManage}>")
    expect(view).toContain("Зөвхөн харах горим")
  })

  test("binds every support mutation to the visible lock version and revalidates", async () => {
    const [queue, detail] = await Promise.all([
      source("../src/routes/support/index.tsx"),
      source("../src/routes/support/[ticketID].tsx"),
    ])
    expect(queue).toContain("mutateAdminSupport(getPlatformAdminContext(), event.request, input)")
    expect(queue).toContain("revalidate: adminSupportQueryKey")
    expect(detail.match(/name="expectedLockVersion"/g)?.length).toBe(3)
    expect(detail).toContain('name="operation" value="reply"')
    expect(detail).toContain('name="operation" value="note"')
    expect(detail).toContain('name="operation" value="update"')
  })

  test("labels internal notes and filters assignment candidates by support permission", async () => {
    const [detail, service] = await Promise.all([
      source("../src/routes/support/[ticketID].tsx"),
      source("../src/lib/admin-support.ts"),
    ])
    expect(detail).toContain("Дотоод тэмдэглэл (хэрэглэгчид харагдахгүй)")
    expect(detail).toContain("Энэ тэмдэглэл хэрэглэгчид огт харагдахгүй.")
    expect(detail).toContain('current.status !== "resolved" && current.status !== "closed"')
    expect(detail).toContain("Холбоо барих имэйл")
    expect(detail).toContain("Админы хариу (хэрэглэгчид харагдана)")
    expect(service).toContain("listAssignableSupportAdmins")
    expect(service).toContain('requirePlatformAdminPermission(context, "support.read")')
    expect(service).toContain('hasPlatformAdminPermission(admin.role, "support.manage")')
  })
})
