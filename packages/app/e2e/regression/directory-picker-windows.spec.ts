import { expect, test } from "@playwright/test"
import { base64Encode } from "@mongolgpt/core/util/encode"
import { dict as mn } from "../../src/i18n/mn"
import { fixture } from "../smoke/session-timeline.fixture"
import { mockMongolGPTServer } from "../utils/mock-server"

const directory = "C:\\Projects\\example"
const home = "C:\\Users\\tester"

for (const modern of [true, false]) {
  for (const recent of [false, true]) {
    test(`Windows folder search preserves resolved results (modern=${modern}, recent=${recent})`, async ({ page }) => {
      await page.addInitScript(
        ({ modern, recent, directory }) => {
          localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: modern } }))
          localStorage.setItem(
            "mongolgpt.global.dat:server",
            JSON.stringify({ projects: { local: recent ? [{ worktree: directory, expanded: true }] : [] } }),
          )
        },
        { modern, recent, directory },
      )
      await mockMongolGPTServer(page, {
        provider: fixture.provider,
        directory,
        home,
        project: { ...fixture.project, worktree: directory, name: "example", sandboxes: [] },
        sessions: [],
        pageMessages: () => ({ items: [] }),
      })
      const children: Record<string, string[]> = {
        "C:/Users/tester": [],
        "C:/": ["Projects"],
        "C:/Projects": ["example"],
        "C:/Projects/example": [".git", "src"],
      }
      await page.route("**/file?*", async (route) => {
        if (route.request().method() !== "GET") return route.fallback()
        const root = new URL(route.request().url()).searchParams.get("directory")?.replaceAll("\\", "/") ?? ""
        return route.fulfill({
          contentType: "application/json",
          headers: {
            "access-control-allow-origin": route.request().headers().origin ?? "*",
            "access-control-allow-credentials": "true",
          },
          body: JSON.stringify(
            (children[root] ?? []).map((name) => ({
              name,
              path: name,
              absolute: `${root.replace(/\/$/, "")}/${name}`.replaceAll("/", "\\"),
              type: "directory",
              ignored: false,
            })),
          ),
        })
      })

      await page.goto("/")
      const surface =
        !modern && recent
          ? page.getByRole("navigation", { name: mn["sidebar.nav.projectsAndSessions"], exact: true })
          : page.getByRole("main")
      const command = modern && recent ? mn["home.project.add"] : mn["command.project.open"]
      await surface.getByRole("button", { name: command, exact: true }).click()
      const dialog = page.getByRole("dialog", { name: mn["command.project.open"], exact: true })
      await expect(dialog).toBeVisible()
      const search = dialog.getByRole("textbox")
      const rows = dialog.locator('[data-slot="list-item"][data-key]')
      for (const input of ["C:/Projects/example", directory, "C:/Projects\\example"]) {
        await search.fill("C:/Projects/does-not-exist-92bf")
        await expect(dialog.getByText(mn["dialog.directory.empty"], { exact: true })).toBeVisible()
        await expect(rows).toHaveCount(0)
        await search.fill(input)
        await expect(rows).toHaveCount(3)
        await expect(rows.first()).toHaveAttribute("data-key", directory)
        await expect(rows.first()).toHaveAttribute("data-active", "true")
        await expect(rows.nth(1)).toHaveAttribute("data-key", `${directory}\\.git`)
        await expect(rows.nth(2)).toHaveAttribute("data-key", `${directory}\\src`)
      }
      if (recent) await expect(dialog.getByText(mn["home.recentProjects"], { exact: true })).toBeVisible()
      await search.press("Enter")
      await expect(dialog).toHaveCount(0)
      if (modern) {
        await expect(page.getByRole("button", { name: "e example", exact: true })).toBeVisible()
      } else {
        await expect(page).toHaveURL(new RegExp(`/${base64Encode(directory)}(?:/|$)`))
      }
    })
  }
}
