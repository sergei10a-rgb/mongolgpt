import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"

const source = (path: string) => Bun.file(resolve(import.meta.dir, path)).text()

describe("customer support view contract", () => {
  test("uses the protected customer HTTP routes without customer identity fields", async () => {
    const client = await source("support-client.ts")
    expect(client).toContain('"/v1/support/tickets"')
    expect(client).toContain('credentials: "same-origin"')
    expect(client).toContain("expectedLockVersion")
    expect(client).not.toContain("accountID")
    expect(client).not.toContain("requesterEmail")
  })

  test("keeps ticket creation and cursor pagination bound to strict public fields", async () => {
    const view = await source("index.tsx")
    expect(view).toContain("subject: subject().trim()")
    expect(view).toContain("workspaceID: workspaceID().trim() || undefined")
    expect(view).toContain("message: message().trim()")
    expect(view).toContain("nextCursor")
    expect(view).toContain("nextPage.items.length === 0")
    expect(view).toContain("Өмнөх")
    expect(view).toContain("Дараах")
    expect(view).toContain("Одоогоор тусламжийн хүсэлт алга.")
  })

  test("renders only customer-safe data and gates replies for resolved or closed tickets", async () => {
    const detail = await source("[ticketID].tsx")
    expect(detail).toContain("ticket.lock_version")
    expect(detail).toContain("Таны зурвас")
    expect(detail).toContain("MongolGPT тусламжийн хариу")
    expect(detail).toContain('detail()?.ticket.status !== "resolved"')
    expect(detail).toContain('detail()?.ticket.status !== "closed"')
    expect(detail).toContain("тул хариу нэмэх")
    expect(detail).toContain("боломжгүй.")
    expect(detail).not.toContain("admin_id")
    expect(detail).not.toContain("internal")
  })

  test("shows the Mongolian support navigation only from the authenticated account menu", async () => {
    const menu = await source("../user-menu.tsx")
    expect(menu).toContain('language.route("/support")')
    expect(menu).toContain("Тусламж")
    expect(menu).toContain("useAuthSession")
  })

  test("keeps public help visible and protects private ticket data through the account API", async () => {
    const view = await source("index.tsx")
    expect(view).toContain("<Header")
    expect(view).toContain("<Footer")
    expect(view).toContain('<LocaleLinks path="/support" />')
    expect(view).toContain("caught.status === 401")
    expect(view).toContain("Нэвтэрч хүсэлт илгээх")
    expect(view).toContain("Алдаа оношлох")
    expect(view).toContain('language.route("/docs/install/")')
    expect(view).toContain('language.route("/auth")')
    expect(view).not.toContain('"/docs/getting-started/"')
    expect(view).not.toContain('href="/auth"')
    expect(view).not.toContain("getActor()")
  })
})
