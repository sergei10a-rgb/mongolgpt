import { expect, test, type Page, type Route } from "@playwright/test"
import { base64Encode } from "@mongolgpt/core/util/encode"

const serverA = "http://127.0.0.1:4096"
const serverB = "http://127.0.0.1:4097"
const serverAPort = new URL(serverA).port
const serverBPort = new URL(serverB).port
const sessionA = session("ses_server_a", "C:/server-a", "Server A session")
const sessionB = session("ses_server_b", "/home/server-b", "Server B session")

for (const width of [1440, 390]) {
  for (const format of ["legacy", "typed"] as const) {
    test(`missing ${format} session opens the remaining tab at ${width}px`, async ({ page }, info) => {
      await page.setViewportSize({ width, height: 900 })
      await mockServers(page, [])
      const missing = "ses_missing_handoff"
      const body =
        format === "legacy"
          ? { name: "NotFoundError", data: { message: `Сесс олдсонгүй: ${missing}` } }
          : { _tag: "SessionNotFoundError", sessionID: missing, message: `Сесс олдсонгүй: ${missing}` }
      await page.route(`${serverA}/session/${missing}*`, (route) => json(route, body, 404))
      await page.addInitScript(
        ({ serverA, serverB, missing, kept }) => {
          localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
          localStorage.setItem("mongolgpt.global.dat:server", JSON.stringify({ list: [serverA, serverB] }))
          localStorage.setItem(
            "mongolgpt.global.dat:tabs",
            JSON.stringify([
              { type: "session", server: serverA, sessionId: missing },
              { type: "session", server: serverB, sessionId: kept },
            ]),
          )
        },
        { serverA, serverB, missing, kept: sessionB.id },
      )
      const errors: string[] = []
      page.on("pageerror", (error) => errors.push(error.message))
      page.on("console", (message) => {
        if (message.type() !== "error" || message.location().url.startsWith(`${serverA}/session/${missing}`)) return
        errors.push(message.text())
      })
      await page.goto(`/server/${base64Encode(serverA)}/session/${missing}`)
      await expect(page).toHaveURL(new RegExp(`/server/${base64Encode(serverB)}/session/${sessionB.id}$`))
      await expect(page.getByRole("heading", { name: "Ямар нэг алдаа гарлаа" })).toHaveCount(0)
      await expect
        .poll(async () => page.evaluate(() => JSON.parse(localStorage.getItem("mongolgpt.global.dat:tabs") ?? "[]")))
        .toEqual([{ type: "session", server: serverB, sessionId: sessionB.id }])
      await expect(page.locator("[data-titlebar-tab-slot] a").filter({ hasText: sessionB.title })).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      expect(errors).toEqual([])
      await page.screenshot({ path: info.outputPath("missing-session-recovered.png"), fullPage: true })
    })
  }

  test(`a missing bookmarked session returns home at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 })
    await mockServers(page, [])
    const missing = "ses_missing_bookmark"
    await page.route(`${serverA}/session/${missing}*`, (route) =>
      json(
        route,
        {
          name: "NotFoundError",
          data: { message: `Сесс олдсонгүй: ${missing}` },
        },
        404,
      ),
    )
    await page.addInitScript(
      ({ serverA }) => {
        localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
        localStorage.setItem("mongolgpt.global.dat:server", JSON.stringify({ list: [serverA] }))
      },
      { serverA },
    )
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    page.on("console", (message) => {
      if (message.type() !== "error" || message.location().url.startsWith(`${serverA}/session/${missing}`)) return
      errors.push(message.text())
    })
    await page.goto(`/server/${base64Encode(serverA)}/session/${missing}`)
    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByRole("heading", { name: "Ямар нэг алдаа гарлаа" })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Шинэ сешн", exact: true }).first()).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(errors).toEqual([])
    await page.screenshot({ path: info.outputPath("missing-session-home.png"), fullPage: true })
  })
}

for (const status of [403, 503]) {
  test(`a ${status} session failure keeps its tab and error visible`, async ({ page }) => {
    await mockServers(page, [])
    const id = "ses_not_authorized_missing"
    await page.route(`${serverA}/session/${id}*`, (route) =>
      json(
        route,
        {
          _tag: "SessionNotFoundError",
          sessionID: id,
          message: `Сесс олдсонгүй: ${id}`,
        },
        status,
      ),
    )
    await page.addInitScript(
      ({ serverA, id }) => {
        localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
        localStorage.setItem("mongolgpt.global.dat:server", JSON.stringify({ list: [serverA] }))
        localStorage.setItem(
          "mongolgpt.global.dat:tabs",
          JSON.stringify([{ type: "session", server: serverA, sessionId: id }]),
        )
      },
      { serverA, id },
    )
    const href = `/server/${base64Encode(serverA)}/session/${id}`
    await page.goto(href)
    await expect(page.getByRole("heading", { name: "Ямар нэг алдаа гарлаа" })).toBeVisible()
    expect(new URL(page.url()).pathname).toBe(href)
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("mongolgpt.global.dat:tabs") ?? "[]"))).toEqual([
      { type: "session", server: serverA, sessionId: id },
    ])
  })
}

test("closing the active server's last tab opens the remaining server tab", async ({ page }) => {
  const requests: string[] = []
  await mockServers(page, requests)
  await page.addInitScript(
    ({ serverA, serverB, sessionA, sessionB }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem("mongolgpt.global.dat:server", JSON.stringify({ list: [serverA, serverB] }))
      localStorage.setItem(
        "mongolgpt.global.dat:tabs",
        JSON.stringify([
          { type: "session", server: "http://127.0.0.1:4096", sessionId: sessionA },
          { type: "session", server: serverB, sessionId: sessionB },
        ]),
      )
    },
    { serverA, serverB, sessionA: sessionA.id, sessionB: sessionB.id },
  )

  const hrefA = `/server/${base64Encode(serverA)}/session/${sessionA.id}`
  const hrefB = `/server/${base64Encode(serverB)}/session/${sessionB.id}`
  await page.goto(hrefA)
  await expect(page.getByText(sessionA.title).first()).toBeVisible()

  const tabA = page.locator(`[data-titlebar-tab-slot]:has(a[href="${hrefA}"])`)
  await tabA.locator('[data-slot="tab-close"] button').click()

  await expect(page).toHaveURL(new RegExp(`${hrefB.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`))
  await expect.poll(() => requests.some((url) => url.startsWith(`${serverB}/session/${sessionB.id}`))).toBe(true)
  await expect(page.getByText(sessionB.title).first()).toBeVisible()
  const sessionBRequests = requests.filter((url) => url.includes(`/session/${sessionB.id}`))
  expect(sessionBRequests.every((url) => url.startsWith(serverB))).toBe(true)
  expect(
    requests.some((request) => {
      const url = new URL(request)
      return url.origin === serverB && url.searchParams.get("directory") === sessionB.directory
    }),
  ).toBe(true)
})

test("legacy session routes preserve an existing tab's server", async ({ page }) => {
  await mockServers(page, [])
  await page.addInitScript(
    ({ serverA, serverB, sessionB }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem("mongolgpt.global.dat:server", JSON.stringify({ list: [serverA, serverB] }))
      localStorage.setItem(
        "mongolgpt.global.dat:tabs",
        JSON.stringify([{ type: "session", server: serverB, sessionId: sessionB }]),
      )
    },
    { serverA, serverB, sessionB: sessionB.id },
  )

  const hrefB = `/server/${base64Encode(serverB)}/session/${sessionB.id}`
  await page.goto(`/${base64Encode(sessionB.directory)}/session/${sessionB.id}`)
  await expect(page).toHaveURL(new RegExp(`${hrefB.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`))
})

function session(id: string, directory: string, title: string) {
  return {
    id,
    slug: id,
    projectID: `project-${id}`,
    directory,
    title,
    version: "dev",
    time: { created: 1, updated: 1 },
  }
}

async function mockServers(page: Page, requests: string[]) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    if (url.port !== serverAPort && url.port !== serverBPort) return route.fallback()
    requests.push(url.toString())
    const current = url.port === serverAPort ? sessionA : sessionB
    const directory = url.searchParams.get("directory")
    if (directory && directory !== current.directory) return json(route, { name: "InvalidDirectory" }, 500)
    if (url.pathname === "/global/event" || url.pathname === "/event") return sse(route)
    if (url.pathname === "/global/health") return json(route, { healthy: true })
    if (url.pathname === "/session") return json(route, [current])
    if (url.pathname === `/session/${current.id}`) return json(route, current)
    if (url.pathname === `/session/${current.id}/message`) return json(route, [])
    if (/^\/session\/[^/]+\/(children|todo|diff)$/.test(url.pathname)) return json(route, [])
    if (["/skill", "/command", "/lsp", "/formatter", "/permission", "/question", "/vcs/diff"].includes(url.pathname))
      return json(route, [])
    if (["/global/config", "/config", "/provider/auth", "/mcp", "/session/status"].includes(url.pathname))
      return json(route, {})
    if (/^\/session\/[^/]+$/.test(url.pathname)) return json(route, { name: "NotFoundError" }, 404)
    if (url.pathname === "/provider")
      return json(route, { all: [], connected: [], default: { providerID: "", modelID: "" } })
    if (url.pathname === "/agent") return json(route, [{ name: "build", mode: "primary" }])
    if (url.pathname === "/project" || url.pathname === "/project/current") {
      const project = {
        id: current.projectID,
        worktree: current.directory,
        vcs: "git",
        time: { created: 1, updated: 1 },
        sandboxes: [],
      }
      return json(route, url.pathname === "/project" ? [project] : project)
    }
    if (url.pathname === "/path")
      return json(route, {
        state: current.directory,
        config: current.directory,
        worktree: current.directory,
        directory: current.directory,
        home: current.directory,
      })
    if (url.pathname === "/vcs") return json(route, { branch: "main", default_branch: "main" })
    return json(route, {})
  })
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify(body),
  })
}

function sse(route: Route) {
  return route.fulfill({ status: 200, contentType: "text/event-stream", body: ": ok\n\n" })
}
