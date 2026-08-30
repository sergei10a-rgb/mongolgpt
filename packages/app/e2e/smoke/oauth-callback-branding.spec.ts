import { expect, test } from "@playwright/test"
import { OauthCallbackPage } from "@mongolgpt/core/oauth/page"

test.describe("OAuth callback branding", () => {
  test("renders the MongolGPT success page without the legacy brand", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.setContent(OauthCallbackPage.success({ provider: "MongolGPT", autoClose: false }))

    await expect(page).toHaveTitle("Зөвшөөрөл амжилттай - MongolGPT")
    await expect(page.locator("html")).toHaveAttribute("lang", "mn")
    await expect(page.getByRole("img", { name: "MongolGPT" })).toBeVisible()
    await expect(page.getByRole("heading", { name: "Зөвшөөрөл амжилттай" })).toBeVisible()
    await expect(page.getByText("MongolGPT бүртгэл амжилттай холбогдлоо.")).toBeVisible()
    await expect(page.locator("main.card")).toHaveAttribute("data-status", "success")
    expect((await page.locator("body").innerText()).toLowerCase()).not.toContain("opencode")
  })

  test("keeps the Mongolian error page inside a dark mobile viewport", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 })
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" })
    await page.setContent(OauthCallbackPage.error("OAuth төлөв буруу байна", { provider: "MongolGPT" }))

    await expect(page).toHaveTitle("Зөвшөөрөл амжилтгүй - MongolGPT")
    await expect(page.getByRole("img", { name: "MongolGPT" })).toBeVisible()
    await expect(page.getByRole("heading", { name: "Зөвшөөрөл амжилтгүй" })).toBeVisible()
    await expect(page.getByText("MongolGPT бүртгэлийг холбож чадсангүй.")).toBeVisible()
    await expect(page.getByText("OAuth төлөв буруу байна")).toBeVisible()
    await expect(page.locator("main.card")).toHaveAttribute("data-status", "error")

    const layout = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      card: document.querySelector("main.card")?.getBoundingClientRect().toJSON(),
    }))
    expect(layout.document).toBeLessThanOrEqual(layout.viewport)
    expect(layout.card?.left).toBeGreaterThanOrEqual(0)
    expect(layout.card?.right).toBeLessThanOrEqual(layout.viewport)
  })
})
