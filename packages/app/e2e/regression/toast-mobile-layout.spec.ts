import { expect, test } from "@playwright/test"
import { base64Encode } from "@mongolgpt/core/util/encode"
import { mockMongolGPTServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/MongolGPT/ToastLayoutRegression"
const projectID = "proj_toast_layout_regression"
const sessionID = "ses_toast_layout_regression"
const longDiagnostic = `Cloud runtime process status is unavailable. ${"CONTAINER_UNAVAILABLE/max_container_instances_exceeded ".repeat(8)}`

test.describe("mobile toast layout", () => {
  for (const modern of [true, false]) {
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 320, height: 500 },
    ]) {
      test(`${modern ? "v2" : "legacy"} stays above an expanded composer at ${viewport.width}x${viewport.height}`, async ({
        page,
      }) => {
        await page.setViewportSize(viewport)
        await setupPage(page, modern)
        await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)

        const editor = page.locator('[data-component="prompt-input"][contenteditable="true"]').first()
        await expectAppVisible(editor)
        await editor.fill("line one\nline two\nline three\nline four\nline five")

        const region = page.locator('[data-component="toast-v2-region"], [data-component="toast-region"]')
        const list = region.locator('[data-slot="toast-v2-list"], [data-slot="toast-list"]')
        const toasts = region.locator('[data-component="toast-v2"], [data-component="toast"]')
        await expect(toasts).toHaveCount(2, { timeout: 10_000 })

        const geometry = await page.evaluate(() => {
          const region = document.querySelector<HTMLElement>(
            '[data-component="toast-v2-region"], [data-component="toast-region"]',
          )
          const list = document.querySelector<HTMLElement>('[data-slot="toast-v2-list"], [data-slot="toast-list"]')
          const composer = document.querySelector<HTMLElement>(
            '[data-component="session-composer"], [data-component="session-new-composer"], [data-component="prompt-input"]',
          )
          const composerRect = composer?.getBoundingClientRect()
          return {
            region: region?.getBoundingClientRect().toJSON(),
            composer: composerRect?.toJSON(),
            scrollWidth: document.documentElement.scrollWidth,
            listClientHeight: list?.clientHeight,
            listScrollHeight: list?.scrollHeight,
            listOverflowY: list ? getComputedStyle(list).overflowY : undefined,
          }
        })

        expect(geometry.region?.top).toBeGreaterThanOrEqual(0)
        expect(geometry.region?.bottom).toBeLessThanOrEqual(geometry.composer.top)
        expect(geometry.listScrollHeight).toBeGreaterThan(geometry.listClientHeight)
        expect(geometry.listOverflowY).toBe("auto")
        expect(geometry.scrollWidth).toBeLessThanOrEqual(viewport.width)
        await expect(toasts.first().getByText(longDiagnostic, { exact: true })).toBeVisible()

        const close = toasts.first().locator('[data-slot="toast-v2-close-button"], [data-slot="toast-close-button"]')
        await expect(close).toBeVisible()
        const closeBox = await close.boundingBox()
        expect(closeBox?.width).toBeGreaterThanOrEqual(32)
        expect(closeBox?.height).toBeGreaterThanOrEqual(32)
        await list.hover()
        await list.evaluate((element) => (element.scrollTop = 0))
        await page.mouse.wheel(0, 300)
        await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
        await close.click()
        await expect(toasts).toHaveCount(1)
        await editor.fill("composer remains interactive")
        await expect(editor).toContainText("composer remains interactive")
      })
    }
  }

  for (const modern of [true, false]) {
    test(`${modern ? "v2" : "legacy"} keeps desktop toast placement`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 })
      await setupPage(page, modern)
      await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
      await expectAppVisible(page.locator('[data-component="prompt-input"][contenteditable="true"]').first())
      const geometry = await page
        .locator('[data-component="toast-v2-region"], [data-component="toast-region"]')
        .evaluate((element) => {
          const rect = element.getBoundingClientRect()
          const style = getComputedStyle(element)
          return { right: innerWidth - rect.right, bottom: innerHeight - rect.bottom, position: style.position }
        })
      expect(geometry.position).toBe("fixed")
      expect(geometry.right).toBeGreaterThanOrEqual(30)
      expect(geometry.right).toBeLessThanOrEqual(34)
      expect(geometry.bottom).toBeGreaterThanOrEqual(46)
      expect(geometry.bottom).toBeLessThanOrEqual(50)
    })
  }
})

async function setupPage(page: Parameters<typeof mockMongolGPTServer>[0], modern: boolean) {
  await page.addInitScript((value) => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: value } }))
  }, modern)
  await mockMongolGPTServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "toast-layout-regression",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "mongolgpt",
          name: "MongolGPT",
          models: { "thinking-model": { id: "thinking-model", name: "Thinking Model", limit: { context: 200_000 } } },
        },
      ],
      connected: ["mongolgpt"],
      default: { mongolgpt: "thinking-model" },
    },
    sessions: [
      {
        id: sessionID,
        slug: sessionID,
        projectID,
        directory,
        title: "Toast layout regression",
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  let providerRequests = 0
  await page.route("**/*", async (route) => {
    if (route.request().method() === "OPTIONS") return route.fallback()
    const path = new URL(route.request().url()).pathname
    if (!path.endsWith("/provider") && path !== "/session") return route.fallback()
    if (path.endsWith("/provider")) {
      providerRequests += 1
      if (providerRequests > 1) return route.fallback()
    }
    const origin = route.request().headers().origin ?? "*"
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      headers: { "access-control-allow-origin": origin, "access-control-allow-credentials": "true" },
      body: JSON.stringify({
        error: "runtime_process_lookup_failed",
        code: "runtime_process_lookup_failed",
        message: longDiagnostic,
      }),
    })
  })
}
