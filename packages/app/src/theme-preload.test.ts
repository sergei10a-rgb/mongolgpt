import { beforeEach, describe, expect, test } from "bun:test"

const src = await Bun.file(new URL("../public/mongolgpt-theme-preload.js", import.meta.url)).text()

const run = () => Function(src)()

beforeEach(() => {
  document.head.innerHTML = ""
  document.documentElement.removeAttribute("data-theme")
  document.documentElement.removeAttribute("data-color-scheme")
  document.documentElement.style.removeProperty("background-color")
  localStorage.clear()
  Object.defineProperty(window, "matchMedia", {
    value: () =>
      ({
        matches: false,
      }) as MediaQueryList,
    configurable: true,
  })
})

describe("theme preload", () => {
  test("uses the canonical MongolGPT theme for a new user", () => {
    run()

    expect(document.documentElement.dataset.theme).toBe("mongolgpt")
    expect(document.documentElement.dataset.colorScheme).toBe("light")
    expect(document.documentElement.style.backgroundColor).toBe("#ffffff")
    expect(localStorage.getItem("mongolgpt-theme-id")).toBe("mongolgpt")
    expect(document.getElementById("mongolgpt-theme-preload")).toBeNull()
  })

  test.each(["oc-1", "oc-2"])("migrates legacy %s to MongolGPT before mount", (legacyTheme) => {
    localStorage.setItem("mongolgpt-theme-id", legacyTheme)
    localStorage.setItem("mongolgpt-theme-css-light", "--background-base:#fff;")
    localStorage.setItem("mongolgpt-theme-css-dark", "--background-base:#000;")
    localStorage.setItem(`opencode-theme-css-${legacyTheme}-light`, "--background-base:#fff;")
    localStorage.setItem(`opencode-theme-css-${legacyTheme}-dark`, "--background-base:#000;")

    run()

    expect(document.documentElement.dataset.theme).toBe("mongolgpt")
    expect(document.documentElement.dataset.colorScheme).toBe("light")
    expect(localStorage.getItem("mongolgpt-theme-id")).toBe("mongolgpt")
    expect(localStorage.getItem("mongolgpt-theme-css-light")).toBeNull()
    expect(localStorage.getItem("mongolgpt-theme-css-dark")).toBeNull()
    expect(localStorage.getItem(`opencode-theme-css-${legacyTheme}-light`)).toBeNull()
    expect(localStorage.getItem(`opencode-theme-css-${legacyTheme}-dark`)).toBeNull()
    expect(document.getElementById("mongolgpt-theme-preload")).toBeNull()
  })

  test("migrates legacy OpenCode storage without losing a custom theme", () => {
    localStorage.setItem("opencode-theme-id", "nightowl")
    localStorage.setItem("opencode-color-scheme", "dark")
    localStorage.setItem("opencode-theme-css-nightowl-dark", "--background-base:#000;")

    run()

    expect(document.documentElement.dataset.theme).toBe("nightowl")
    expect(document.documentElement.dataset.colorScheme).toBe("dark")
    expect(localStorage.getItem("mongolgpt-theme-id")).toBe("nightowl")
    expect(localStorage.getItem("mongolgpt-color-scheme")).toBe("dark")
    expect(localStorage.getItem("mongolgpt-theme-css-dark")).toBe("--background-base:#000;")
    expect(localStorage.getItem("opencode-theme-id")).toBeNull()
    expect(localStorage.getItem("opencode-color-scheme")).toBeNull()
    expect(localStorage.getItem("opencode-theme-css-nightowl-dark")).toBeNull()
    expect(document.getElementById("mongolgpt-theme-preload")?.textContent).toContain("--background-base:#000;")
  })

  test("keeps cached css for non-default themes", () => {
    localStorage.setItem("mongolgpt-theme-id", "nightowl")
    localStorage.setItem("mongolgpt-theme-css-light", "--background-base:#fff;")

    run()

    expect(document.documentElement.dataset.theme).toBe("nightowl")
    expect(document.getElementById("mongolgpt-theme-preload")?.textContent).toContain("--background-base:#fff;")
  })
})
