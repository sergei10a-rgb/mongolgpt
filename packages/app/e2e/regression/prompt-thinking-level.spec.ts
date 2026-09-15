import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@mongolgpt/core/util/encode"
import { mockMongolGPTServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/MongolGPT/PromptThinkingLevelRegression"
const projectID = "proj_prompt_thinking_level_regression"
const sessionID = "ses_prompt_thinking_level_regression"

test.beforeEach(async ({ page }) => {
  await mockMongolGPTServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "prompt-thinking-level-regression",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "mongolgpt",
          name: "MongolGPT",
          models: {
            "thinking-model": {
              id: "thinking-model",
              name: "Nemotron 3.5 Lightning Free",
              limit: { context: 200_000 },
              variants: { high: {} },
            },
          },
        },
      ],
      connected: ["mongolgpt"],
      default: { providerID: "mongolgpt", modelID: "thinking-model" },
    },
    sessions: [
      {
        id: sessionID,
        slug: "prompt-thinking-level-regression",
        projectID,
        directory,
        title: "Prompt thinking level regression",
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
    localStorage.setItem("mongolgpt.global.dat:language", JSON.stringify({ locale: "mn", source: "user" }))
  })
})

test("shows the V2 thinking level control while relevant", async ({ page }) => {
  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  const composer = page.locator('[data-component="session-composer"]')
  const input = composer.locator('[data-component="prompt-input"]')
  const control = composer.locator('[data-component="prompt-variant-control"]')
  await expectAppVisible(composer)

  await idleComposer(page)
  await expect(control).toBeHidden()

  await composer.hover()
  await expect(control).toBeVisible()

  await control.locator('[data-action="prompt-model-variant"]').click()
  const high = page.getByRole("option", { name: "high" })
  await expect(high).toBeVisible()
  await page.mouse.move(0, 0)
  await expect(control).toBeVisible()
  await expect(high).toBeVisible()
  await high.click()

  await idleComposer(page)
  await input.focus()
  await expect(control).toBeVisible()

  await idleComposer(page)
  await expect(control).toBeVisible()
})

for (const width of [320, 390, 1365]) {
  for (const existing of [false, true]) {
    test(`keeps composer controls separate at ${width}px (${existing ? "existing" : "new"} session)`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 })
      await page.goto(`/${base64Encode(directory)}/session${existing ? `/${sessionID}` : ""}`)
      const composer = page.locator('[data-component="session-composer"], [data-component="session-new-composer"]')
      await expectAppVisible(composer)
      await composer.locator('[data-component="prompt-input"]').fill("Layout test draft")
      const variant = composer.locator('[data-action="prompt-model-variant"]')
      await expect(variant).toBeVisible()
      await expect(composer.locator('[data-action="prompt-submit"]')).toBeEnabled()
      await expect
        .poll(() =>
          composer.evaluate((el) => {
            const bounds = el.getBoundingClientRect()
            const controls = Array.from(el.querySelectorAll<HTMLElement>('[data-action^="prompt-"]'))
              .filter((control) => control.offsetWidth && control.offsetHeight)
              .map((control) => control.getBoundingClientRect())
            return controls.every(
              (rect, index) =>
                rect.left >= bounds.left - 0.5 &&
                rect.right <= bounds.right + 0.5 &&
                controls
                  .slice(index + 1)
                  .every(
                    (other) =>
                      rect.right <= other.left + 0.5 ||
                      other.right <= rect.left + 0.5 ||
                      rect.bottom <= other.top + 0.5 ||
                      other.bottom <= rect.top + 0.5,
                  ),
            )
          }),
        )
        .toBe(true)
      await variant.click()
      await page.getByRole("option", { name: "high", exact: true }).click()
      await expect(variant).toContainText("high")
      await composer.locator('[data-action="prompt-model"]').click()
      const models = page.getByRole("dialog", { name: "Загвар сонгох", exact: true })
      await expect(models.getByRole("button", { name: "Nemotron 3.5 Lightning Free", exact: true })).toBeVisible()
    })
  }
}

async function idleComposer(page: Page) {
  await page.mouse.move(0, 0)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
}
