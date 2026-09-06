import { expect, test, type Page, type TestInfo } from "@playwright/test"
import { mockMongolGPTServer } from "../utils/mock-server"
import { expectAppVisible, expectSessionTitle } from "../utils/waits"

const directory = "C:/MongolGPT/ComposerResizeRegression"
const projectID = "proj_composer_resize_regression"
const firstSessionID = "ses_composer_resize_first"
const secondSessionID = "ses_composer_resize_second"
const firstTitle = "Composer resize first"
const secondTitle = "Composer resize second"
const model = { providerID: "mongolgpt", modelID: "claude-opus-4-6", variant: "max" }

for (const viewport of [
  { name: "desktop", width: 1400, height: 900 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`session composer grows, resets, and survives transition without resize errors (${viewport.name})`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height })

    let phase = "navigation"
    const resizeNotifications: string[] = []
    const pageErrors: string[] = []
    const events: EventPayload[] = []
    page.on("pageerror", (error) => {
      pageErrors.push(`${phase}: ${error.message}`)
      if (/ResizeObserver/i.test(error.message)) resizeNotifications.push(`${phase} pageerror: ${error.message}`)
    })
    page.on("console", (message) => {
      if (/ResizeObserver/i.test(message.text())) {
        resizeNotifications.push(`${phase} console.${message.type()}: ${message.text()}`)
      }
    })

    await mockServer(page, events)
    let streamedAssistantID = ""
    await page.route("**/session/*/prompt_async", async (route) => {
      const body = route.request().postDataJSON() as { messageID?: string }
      if (!body.messageID) throw new Error("prompt_async request did not include messageID")
      streamedAssistantID = `${body.messageID}_assistant`
      events.push(...streamEvents(body.messageID, streamedAssistantID))
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({}),
      })
    })

    await configurePage(page)
    await page.goto(sessionHref(firstSessionID))
    await expectSessionTitle(page, firstTitle)
    const composer = page.locator('[data-component="session-composer"]')
    const input = composer.locator('[data-component="prompt-input"]')
    await expectAppVisible(composer)
    await expect(input).toBeVisible()

    const before = await geometry(page)
    phase = "editor-growth"
    await input.fill(Array.from({ length: 18 }, (_, index) => `composer growth line ${index}`).join("\n"))
    await expect.poll(async () => (await geometry(page)).input.height).toBeGreaterThan(before.input.height)
    const grown = await geometry(page)
    await screenshot(page, testInfo, `${viewport.name}-grown`)

    phase = "editor-clear"
    await input.fill("short prompt")
    await expect(input).toHaveText("short prompt")

    if (viewport.name === "desktop") {
      const reviewToggle = page.locator('[aria-controls="review-panel"]').first()
      if ((await reviewToggle.getAttribute("aria-expanded")) === "true") await reviewToggle.click()
      await expect(page.locator("#review-panel")).toHaveAttribute("aria-hidden", "true")
    }

    phase = "submit-clear"
    await Promise.all([
      page.waitForResponse((response) => response.url().includes(`/session/${firstSessionID}/prompt_async`)),
      composer.locator('[data-action="prompt-submit"]').click(),
    ])
    await expect.poll(async () => (await input.textContent())?.trim() ?? "").toBe("")
    await settle(page)
    const reset = await geometry(page)
    await screenshot(page, testInfo, `${viewport.name}-reset`)

    phase = "assistant-stream"
    const streamed = page.locator(`[data-timeline-part-id="${streamedAssistantID}_part"]`).first()
    await expect(streamed).toHaveText("MONGOLGPT_DESKTOP_02BFC9A_OK")
    await expect(streamed).toBeVisible()
    phase = "assistant-complete"
    await expect(composer.locator('[data-action="prompt-submit"]')).toBeDisabled()
    await settle(page)
    const completed = await geometry(page)
    await screenshot(page, testInfo, `${viewport.name}-streamed`)

    phase = "session-transition"
    await switchSession(page, secondSessionID, secondTitle)
    const transitionedComposer = page.locator('[data-component="session-composer"]')
    await expectAppVisible(transitionedComposer)
    await expect(transitionedComposer.locator('[data-component="prompt-input"]')).toBeVisible()
    await settle(page)
    const transitioned = await geometry(page)
    await screenshot(page, testInfo, `${viewport.name}-transitioned`)
    await settle(page)

    for (const sample of [before, grown, reset, completed, transitioned]) {
      expect(sample.dock.top, "composer dock must stay below the viewport top").toBeGreaterThanOrEqual(0)
      expect(sample.dock.left, "composer dock must stay within the viewport").toBeGreaterThanOrEqual(0)
      expect(sample.dock.right, "composer dock must not overflow the viewport").toBeLessThanOrEqual(viewport.width + 1)
      expect(sample.dock.bottom, "composer dock must stay within the viewport").toBeLessThanOrEqual(viewport.height + 1)
      expect(sample.input.left, "prompt input must stay within the viewport").toBeGreaterThanOrEqual(0)
      expect(sample.input.right, "prompt input must not overflow the viewport").toBeLessThanOrEqual(viewport.width + 1)
      expect(sample.input.top, "prompt input must stay below the viewport top").toBeGreaterThanOrEqual(0)
      expect(sample.input.bottom, "prompt input must stay above the viewport bottom").toBeLessThanOrEqual(
        viewport.height + 1,
      )
    }

    expect(resizeNotifications, "observed ResizeObserver notifications").toEqual([])
    expect(pageErrors, "unhandled browser errors").toEqual([])
  })
}

async function geometry(page: Page) {
  return page.evaluate(() => {
    const dock = document.querySelector<HTMLElement>('[data-component="session-prompt-dock"]')
    const input = document.querySelector<HTMLElement>('[data-component="prompt-input"]')
    if (!dock || !input) throw new Error("session composer geometry nodes are missing")
    const rect = (element: HTMLElement) => {
      const box = element.getBoundingClientRect()
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, height: box.height }
    }
    return { dock: rect(dock), input: rect(input) }
  })
}

async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: false })
}

async function settle(page: Page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

async function mockServer(page: Page, events: EventPayload[]) {
  await mockMongolGPTServer(page, {
    directory,
    project: project(),
    provider: provider(),
    sessions: [session(firstSessionID, firstTitle), session(secondSessionID, secondTitle)],
    pageMessages: (sessionID) => ({ items: history(sessionID) }),
    events: () => events.splice(0, 1),
    eventRetry: 16,
  })
}

async function configurePage(page: Page) {
  const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
  await page.addInitScript(
    ({ directory, dirBase64, server, sessionIDs }) => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
      localStorage.setItem(
        "mongolgpt.global.dat:tabs",
        JSON.stringify(sessionIDs.map((sessionID) => ({ type: "session", server, dirBase64, sessionId: sessionID }))),
      )
      localStorage.setItem(
        "mongolgpt.global.dat:server",
        JSON.stringify({
          projects: { local: [{ worktree: directory, expanded: true }] },
          lastProject: { local: directory },
        }),
      )
    },
    { directory, dirBase64: base64Encode(directory), server, sessionIDs: [firstSessionID, secondSessionID] },
  )
}

async function switchSession(page: Page, sessionID: string, title: string) {
  const href = sessionHref(sessionID)
  await expect(page.locator(`[data-slot="titlebar-tabs"] a[href="${href}"]`).first()).toBeVisible()
  await page.locator(`[data-slot="titlebar-tabs"] a[href="${href}"]`).first().click()
  await expectSessionTitle(page, title)
}

function sessionHref(sessionID: string) {
  const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
  return `/server/${base64Encode(server)}/session/${sessionID}`
}

function project() {
  return {
    id: projectID,
    worktree: directory,
    vcs: "git",
    name: "composer-resize-regression",
    time: { created: 1700000000000, updated: 1700000000000 },
    sandboxes: [],
  }
}

function session(id: string, title: string) {
  return {
    id,
    slug: id,
    projectID,
    directory,
    title,
    version: "dev",
    time: { created: 1700000000000, updated: 1700000000000 },
    model,
  }
}

function history(sessionID: string) {
  const userID = "msg_00000000000001"
  const assistantID = "msg_00000000000002"
  return [
    {
      info: {
        id: userID,
        sessionID,
        role: "user",
        time: { created: 1700000000000 },
        summary: { diffs: [] },
        agent: "build",
        model,
      },
      parts: [{ id: `${userID}_part`, sessionID, messageID: userID, type: "text", text: "Short history question." }],
    },
    {
      info: {
        id: assistantID,
        sessionID,
        role: "assistant",
        time: { created: 1700000001000, completed: 1700000002000 },
        parentID: userID,
        modelID: model.modelID,
        providerID: model.providerID,
        mode: "build",
        agent: "build",
        path: { cwd: directory, root: directory },
        cost: 0,
        tokens: { input: 10, output: 8, reasoning: 0, cache: { read: 0, write: 0 } },
        variant: model.variant,
        finish: "stop",
      },
      parts: [
        { id: `${assistantID}_part`, sessionID, messageID: assistantID, type: "text", text: "Short history answer." },
      ],
    },
  ]
}

function streamEvents(userID: string, assistantID: string): EventPayload[] {
  const partID = `${assistantID}_part`
  return [
    {
      directory,
      payload: { type: "session.status", properties: { sessionID: firstSessionID, status: { type: "busy" } } },
    },
    {
      directory,
      payload: {
        type: "message.updated",
        properties: {
          info: {
            id: userID,
            sessionID: firstSessionID,
            role: "user",
            time: { created: 1700000002500 },
            summary: { diffs: [] },
            agent: "build",
            model,
          },
        },
      },
    },
    {
      directory,
      payload: {
        type: "message.part.updated",
        properties: {
          part: {
            id: `${userID}_part`,
            sessionID: firstSessionID,
            messageID: userID,
            type: "text",
            text: "short prompt",
          },
        },
      },
    },
    {
      directory,
      payload: {
        type: "message.updated",
        properties: {
          info: {
            id: assistantID,
            sessionID: firstSessionID,
            role: "assistant",
            time: { created: 1700000003000 },
            parentID: userID,
            modelID: model.modelID,
            providerID: model.providerID,
            mode: "build",
            agent: "build",
            path: { cwd: directory, root: directory },
            cost: 0,
            tokens: { input: 12, output: 3, reasoning: 0, cache: { read: 0, write: 0 } },
            variant: model.variant,
          },
        },
      },
    },
    {
      directory,
      payload: {
        type: "message.part.updated",
        properties: {
          part: {
            id: partID,
            sessionID: firstSessionID,
            messageID: assistantID,
            type: "text",
            text: "MONGOLGPT_DESKTOP_",
          },
        },
      },
    },
    {
      directory,
      payload: {
        type: "message.part.delta",
        properties: {
          sessionID: firstSessionID,
          messageID: assistantID,
          partID,
          field: "text",
          delta: "02BFC9A_",
        },
      },
    },
    {
      directory,
      payload: {
        type: "message.part.delta",
        properties: {
          sessionID: firstSessionID,
          messageID: assistantID,
          partID,
          field: "text",
          delta: "OK",
        },
      },
    },
    {
      directory,
      payload: {
        type: "message.updated",
        properties: {
          info: {
            id: assistantID,
            sessionID: firstSessionID,
            role: "assistant",
            time: { created: 1700000003000, completed: 1700000004000 },
            parentID: userID,
            modelID: model.modelID,
            providerID: model.providerID,
            mode: "build",
            agent: "build",
            path: { cwd: directory, root: directory },
            cost: 0,
            tokens: { input: 12, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
            variant: model.variant,
            finish: "stop",
          },
        },
      },
    },
    {
      directory,
      payload: { type: "session.status", properties: { sessionID: firstSessionID, status: { type: "idle" } } },
    },
  ]
}

type EventPayload = { directory: string; payload: Record<string, unknown> }

function provider() {
  return {
    all: [
      {
        id: "mongolgpt",
        name: "MongolGPT",
        models: { "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } } },
      },
    ],
    connected: ["mongolgpt"],
    default: { providerID: model.providerID, modelID: model.modelID },
  }
}

function base64Encode(value: string) {
  return Buffer.from(value, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}
