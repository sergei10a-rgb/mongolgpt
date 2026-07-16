import { beforeEach, describe, expect, test } from "bun:test"
import { applyTheme, getActiveTheme, removeTheme } from "@mongolgpt/ui/theme/loader"
import { DEFAULT_THEMES, mongolgptTheme } from "@mongolgpt/ui/theme/default-themes"

beforeEach(() => {
  document.head.innerHTML = ""
  document.documentElement.removeAttribute("data-theme")
  removeTheme()
})

describe("theme loader identity migration", () => {
  test("exposes MongolGPT as the only canonical default identity", () => {
    expect(DEFAULT_THEMES.mongolgpt).toBe(mongolgptTheme)
    expect(DEFAULT_THEMES["oc-2"]).toBeUndefined()
  })

  test.each(["oc-1", "oc-2"])("normalizes legacy %s identity and style element", (legacyTheme) => {
    const legacyStyle = document.createElement("style")
    legacyStyle.id = "oc-theme"
    document.head.appendChild(legacyStyle)

    applyTheme(mongolgptTheme, legacyTheme)

    expect(document.documentElement.dataset.theme).toBe("mongolgpt")
    expect(document.getElementById("mongolgpt-theme")).toBe(legacyStyle)
    expect(document.getElementById("oc-theme")).toBeNull()
    expect(getActiveTheme()).toBe(mongolgptTheme)
  })

  test("keeps a custom theme identity", () => {
    applyTheme(mongolgptTheme, "custom-theme")

    expect(document.documentElement.dataset.theme).toBe("custom-theme")
    expect(document.getElementById("mongolgpt-theme")?.textContent).toContain('html[data-theme="custom-theme"]')
  })
})
