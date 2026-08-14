import { afterEach, describe, expect, test } from "bun:test"
import { ThemeTesting } from "./context"

const values = new Map<string, string>()
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem(key: string) {
      return values.get(key) ?? null
    },
    setItem(key: string, value: string) {
      values.set(key, value)
    },
    removeItem(key: string) {
      values.delete(key)
    },
    clear() {
      values.clear()
    },
  },
})

afterEach(() => {
  values.clear()
})

describe("theme storage migration", () => {
  test("moves legacy OpenCode preferences to MongolGPT keys and removes the legacy keys", () => {
    values.set("opencode-theme-id", "nightowl")
    values.set("opencode-color-scheme", "dark")
    values.set("opencode-theme-css-nightowl-dark", "--background-base:#000;")

    expect(ThemeTesting.migrateStoredTheme()).toBe("nightowl")
    expect(ThemeTesting.migrateStoredColorScheme()).toBe("dark")

    expect(values.get("mongolgpt-theme-id")).toBe("nightowl")
    expect(values.get("mongolgpt-color-scheme")).toBe("dark")
    expect(values.get("mongolgpt-theme-css-dark")).toBe("--background-base:#000;")
    expect(values.has("opencode-theme-id")).toBeFalse()
    expect(values.has("opencode-color-scheme")).toBeFalse()
    expect(values.has("opencode-theme-css-nightowl-dark")).toBeFalse()
  })

  test("keeps the current MongolGPT preference when a stale legacy key is present", () => {
    values.set("mongolgpt-theme-id", "dracula")
    values.set("opencode-theme-id", "nightowl")

    expect(ThemeTesting.migrateStoredTheme()).toBe("dracula")
    expect(values.get("mongolgpt-theme-id")).toBe("dracula")
    expect(values.has("opencode-theme-id")).toBeFalse()
  })
})
