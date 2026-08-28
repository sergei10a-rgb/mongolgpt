import { expect, test, type Route } from "@playwright/test"
import { dict as mn } from "../../src/i18n/mn"
import { fixture, pageMessages } from "./session-timeline.fixture"
import { trackPageErrors } from "../utils/errors"
import { mockMongolGPTServer } from "../utils/mock-server"

const configPath = "C:/Users/e2e/.config/mongolgpt/mongolgpt.jsonc"
const adapterFile = "C:/Users/e2e/.config/mongolgpt/plugins/adapters/acme-plugin.compat.js"
const operation = {
  kind: "plugin",
  source: "acme-plugin",
  spec: "./plugins/adapters/acme-plugin.compat.js",
  adapter: {
    file: adapterFile,
    target: "acme-plugin",
    format: "planned-js",
    original: "acme-plugin",
  },
}

test("plans, previews, and applies an automatically adapted plugin from Mongolian settings", async ({ page }) => {
  const errors = trackPageErrors(page)
  await mockMongolGPTServer(page, {
    sessions: fixture.sessions,
    provider: fixture.provider,
    directory: fixture.directory,
    project: fixture.project,
    pageMessages,
  })

  const requests: Array<{ mode: string; payload: unknown }> = []
  await page.route("**/compat/import/*", async (route) => {
    if (route.request().method() === "OPTIONS") return preflight(route)
    const mode = new URL(route.request().url()).pathname.split("/").at(-1) ?? ""
    requests.push({ mode, payload: route.request().postDataJSON() })
    return json(route, {
      scope: "global",
      configPath,
      operations: [operation],
      prepared: [operation],
      descriptions: ["acme-plugin нэмэлтийг MongolGPT adapter-аар тохируулна"],
      warnings: [],
      outcomes: [{ mode: "add", operation }],
      existingConfigText: "{}",
      nextConfigText: '{"plugin":["./plugins/adapters/acme-plugin.compat.js"]}',
      configExists: false,
    })
  })

  await page.goto("/")
  await page.getByRole("button", { name: mn["sidebar.settings"], exact: true }).click()
  await page.getByRole("tab", { name: mn["settings.imports.title"], exact: true }).click()

  await expect(page.getByText(mn["settings.imports.section.title"], { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: mn["settings.imports.type.auto"], exact: true })).toBeVisible()
  const plan = page.getByRole("button", { name: "Төлөвлөгөө гаргах", exact: true })
  const apply = page.getByRole("button", { name: "Суулгах", exact: true })
  await expect(plan).toBeDisabled()
  await expect(apply).toBeDisabled()

  const source = page.getByLabel("Эх сурвалж", { exact: true })
  await source.fill("acme-plugin")
  await expect(plan).toBeEnabled()
  await plan.click()

  await expect.poll(() => requests.length).toBe(1)
  expect(requests[0]).toEqual({
    mode: "plan",
    payload: {
      type: "auto",
      scope: "global",
      source: "acme-plugin",
      adapter: true,
    },
  })
  await expect(page.getByText(configPath, { exact: true })).toBeVisible()
  await expect(page.getByText(`acme-plugin -> ${adapterFile}`, { exact: true })).toBeVisible()
  await expect(page.getByText(mn["settings.imports.outcome.add"], { exact: true })).toBeVisible()
  await expect(apply).toBeEnabled()

  await source.fill("another-plugin")
  await expect(apply).toBeDisabled()
  await source.fill("acme-plugin")
  await expect(apply).toBeEnabled()
  await apply.click()

  await expect.poll(() => requests.length).toBe(2)
  expect(requests[1]).toEqual({
    mode: "apply",
    payload: {
      type: "auto",
      scope: "global",
      source: "acme-plugin",
      adapter: true,
    },
  })
  await expect(page.getByText(`acme-plugin -> ${adapterFile}`, { exact: true })).toBeVisible()
  expect(errors).toEqual([])
})

function preflight(route: Route) {
  return route.fulfill({ status: 204, headers: cors(route) })
}

function json(route: Route, body: unknown) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: cors(route),
    body: JSON.stringify(body),
  })
}

function cors(route: Route) {
  const origin = route.request().headers().origin
  const requestedHeaders = route.request().headers()["access-control-request-headers"]
  return {
    ...(origin ? { "access-control-allow-origin": origin } : {}),
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": "POST, OPTIONS",
    ...(requestedHeaders ? { "access-control-allow-headers": requestedHeaders } : {}),
    vary: "Origin",
  }
}
