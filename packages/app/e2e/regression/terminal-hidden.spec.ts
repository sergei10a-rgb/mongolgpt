import { expect, test } from "@playwright/test"
import { mockMongolGPTServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/MongolGPT/HiddenTerminalRegression"
const projectID = "proj_hidden_terminal_regression"
const sessionID = "ses_hidden_terminal_regression"
const title = "Hidden terminal regression"

test("unmounts hidden or exited terminals without updating exited PTYs", async ({ page }) => {
  const events: unknown[] = []
  const updatesAfterExit: unknown[] = []
  let updateCount = 0
  let exited = false
  await page.setViewportSize({ width: 1400, height: 900 })
  await mockMongolGPTServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "hidden-terminal-regression",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "mongolgpt",
          name: "MongolGPT",
          models: { test: { id: "test", name: "Test", limit: { context: 200_000 } } },
        },
      ],
      connected: ["mongolgpt"],
      default: { providerID: "mongolgpt", modelID: "test" },
    },
    sessions: [
      {
        id: sessionID,
        slug: "hidden-terminal-regression",
        projectID,
        directory,
        title,
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
    events: () => events.splice(0, 1),
    eventRetry: 16,
  })
  await page.route("**/pty", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: "pty_hidden_terminal", title: "Terminal 1" }),
    }),
  )
  await page.route("**/pty/pty_hidden_terminal", (route) => {
    if (route.request().method() === "PUT") {
      updateCount += 1
      if (exited) updatesAfterExit.push(route.request().postDataJSON())
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
  })
  await page.routeWebSocket("**/pty/pty_hidden_terminal/connect", () => undefined)

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, title)

  await page.keyboard.press("Control+Backquote")
  const panel = page.locator("#terminal-panel")
  await expect(panel).toHaveAttribute("aria-hidden", "false")
  await expect(page.locator('[data-component="terminal"]')).toBeVisible()

  await page.keyboard.press("Control+Backquote")
  await expect(panel).toHaveAttribute("aria-hidden", "true")
  await expect(page.locator('[data-component="terminal"]')).toHaveCount(0)

  await page.setViewportSize({ width: 1200, height: 700 })
  await expect(page.locator('[data-component="terminal"]')).toHaveCount(0)

  const beforeReopen = updateCount
  await page.keyboard.press("Control+Backquote")
  await expect(page.locator('[data-component="terminal"]')).toBeVisible()
  await expect.poll(() => updateCount).toBeGreaterThan(beforeReopen)

  // The exit event removes the PTY before the renderer persists its final buffer.
  exited = true
  events.push({ directory, payload: { type: "pty.exited", properties: { id: "pty_hidden_terminal", exitCode: 0 } } })
  await expect(page.locator('[data-component="terminal"]')).toHaveCount(0)
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  expect(updatesAfterExit).toEqual([])
})

function base64Encode(value: string) {
  return Buffer.from(value, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}
