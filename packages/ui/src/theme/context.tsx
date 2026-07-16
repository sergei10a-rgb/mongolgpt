// @refresh reload

import { createEffect, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createSimpleContext } from "../context/helper"
import mongolgptThemeJson from "./themes/mongolgpt.json"
import { resolveThemeVariant, themeToCss } from "./resolve"
import { resolveThemeVariantV2, themeV2ToCss } from "./v2/resolve"
import type { DesktopTheme } from "./types"

export type ColorScheme = "light" | "dark" | "system"

const DEFAULT_THEME_ID = "mongolgpt"
const LEGACY_THEME_IDS = new Set(["oc-1", "oc-2"])
const STORAGE_KEYS = {
  THEME_ID: "mongolgpt-theme-id",
  COLOR_SCHEME: "mongolgpt-color-scheme",
  THEME_CSS_LIGHT: "mongolgpt-theme-css-light",
  THEME_CSS_DARK: "mongolgpt-theme-css-dark",
} as const
const LEGACY_STORAGE_KEYS = {
  THEME_ID: "opencode-theme-id",
  COLOR_SCHEME: "opencode-color-scheme",
  THEME_CSS_PREFIX: "opencode-theme-css",
} as const

const THEME_STYLE_ID = "mongolgpt-theme"
const THEME_PRELOAD_STYLE_ID = "mongolgpt-theme-preload"
const LEGACY_THEME_STYLE_IDS = ["oc-theme"] as const
const LEGACY_THEME_PRELOAD_STYLE_IDS = ["oc-theme-preload"] as const
let files: Record<string, () => Promise<{ default: DesktopTheme }>> | undefined
let ids: string[] | undefined
let known: Set<string> | undefined

function getFiles() {
  if (files) return files
  files = import.meta.glob<{ default: DesktopTheme }>([
    "./themes/*.json",
    "!./themes/mongolgpt.json",
    "!./themes/oc-2.json",
  ])
  return files
}

function themeIDs() {
  if (ids) return ids
  ids = [
    DEFAULT_THEME_ID,
    ...Object.keys(getFiles())
      .map((path) => path.slice("./themes/".length, -".json".length))
      .filter((id) => !LEGACY_THEME_IDS.has(id)),
  ].sort()
  return ids
}

function knownThemes() {
  if (known) return known
  known = new Set(themeIDs())
  return known
}

const names: Record<string, string> = {
  amoled: "AMOLED",
  aura: "Aura",
  ayu: "Ayu",
  carbonfox: "Carbonfox",
  catppuccin: "Catppuccin",
  "catppuccin-frappe": "Catppuccin Frappe",
  "catppuccin-macchiato": "Catppuccin Macchiato",
  cobalt2: "Cobalt2",
  cursor: "Cursor",
  dracula: "Dracula",
  everforest: "Everforest",
  flexoki: "Flexoki",
  github: "GitHub",
  gruvbox: "Gruvbox",
  kanagawa: "Kanagawa",
  "lucent-orng": "Lucent Orng",
  material: "Material",
  matrix: "Matrix",
  mercury: "Mercury",
  monokai: "Monokai",
  nightowl: "Night Owl",
  nord: "Nord",
  "one-dark": "One Dark",
  onedarkpro: "One Dark Pro",
  mongolgpt: "MongolGPT",
  orng: "Orng",
  "osaka-jade": "Osaka Jade",
  palenight: "Palenight",
  rosepine: "Rose Pine",
  shadesofpurple: "Shades of Purple",
  solarized: "Solarized",
  synthwave84: "Synthwave '84",
  tokyonight: "Tokyonight",
  vercel: "Vercel",
  vesper: "Vesper",
  zenburn: "Zenburn",
}
const mongolgptTheme = mongolgptThemeJson as DesktopTheme

function normalizeThemeId(id: string | null | undefined) {
  return id && LEGACY_THEME_IDS.has(id) ? DEFAULT_THEME_ID : id
}

function read(key: string) {
  if (typeof localStorage !== "object") return null
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string) {
  if (typeof localStorage !== "object") return
  try {
    localStorage.setItem(key, value)
  } catch {}
}

function drop(key: string) {
  if (typeof localStorage !== "object") return
  try {
    localStorage.removeItem(key)
  } catch {}
}

function clear() {
  drop(STORAGE_KEYS.THEME_CSS_LIGHT)
  drop(STORAGE_KEYS.THEME_CSS_DARK)
}

function migrateLegacyCss(rawTheme: string | null | undefined, themeId: string) {
  if (rawTheme) {
    for (const mode of ["light", "dark"] as const) {
      const key = mode === "dark" ? STORAGE_KEYS.THEME_CSS_DARK : STORAGE_KEYS.THEME_CSS_LIGHT
      const legacyKey = `${LEGACY_STORAGE_KEYS.THEME_CSS_PREFIX}-${rawTheme}-${mode}`
      if (themeId !== DEFAULT_THEME_ID) {
        const css = read(key) ?? read(legacyKey)
        if (css) write(key, css)
      }
      drop(legacyKey)
    }
  }
  if (themeId === DEFAULT_THEME_ID) clear()
}

function migrateStoredTheme(fallback?: string) {
  const current = read(STORAGE_KEYS.THEME_ID)
  const legacy = read(LEGACY_STORAGE_KEYS.THEME_ID)
  const raw = current ?? legacy ?? fallback
  const themeId = normalizeThemeId(raw) ?? DEFAULT_THEME_ID
  if (current !== themeId) write(STORAGE_KEYS.THEME_ID, themeId)
  if (legacy !== null) drop(LEGACY_STORAGE_KEYS.THEME_ID)
  migrateLegacyCss(raw, themeId)
  return themeId
}

function normalizeColorScheme(value: string | null): ColorScheme {
  return value === "light" || value === "dark" || value === "system" ? value : "system"
}

function migrateStoredColorScheme() {
  const current = read(STORAGE_KEYS.COLOR_SCHEME)
  const legacy = read(LEGACY_STORAGE_KEYS.COLOR_SCHEME)
  const scheme = normalizeColorScheme(current ?? legacy)
  if (current !== scheme) write(STORAGE_KEYS.COLOR_SCHEME, scheme)
  if (legacy !== null) drop(LEGACY_STORAGE_KEYS.COLOR_SCHEME)
  return scheme
}

function ensureThemeStyleElement(): HTMLStyleElement {
  const existing = document.getElementById(THEME_STYLE_ID) as HTMLStyleElement | null
  if (existing) {
    for (const id of LEGACY_THEME_STYLE_IDS) document.getElementById(id)?.remove()
    return existing
  }
  for (const id of LEGACY_THEME_STYLE_IDS) {
    const legacy = document.getElementById(id) as HTMLStyleElement | null
    if (!legacy) continue
    legacy.id = THEME_STYLE_ID
    return legacy
  }
  const element = document.createElement("style")
  element.id = THEME_STYLE_ID
  document.head.appendChild(element)
  return element
}

function getSystemMode(): "light" | "dark" {
  if (typeof window !== "object") return "light"
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

function applyThemeCss(theme: DesktopTheme, themeId: string, mode: "light" | "dark") {
  const isDark = mode === "dark"
  const variant = isDark ? theme.dark : theme.light
  const tokens = resolveThemeVariant(variant, isDark)
  const css = themeToCss(tokens)
  const v2 = themeV2ToCss(resolveThemeVariantV2(variant, isDark))

  if (themeId !== DEFAULT_THEME_ID) {
    write(isDark ? STORAGE_KEYS.THEME_CSS_DARK : STORAGE_KEYS.THEME_CSS_LIGHT, `${css}\n  ${v2}`)
  }

  const fullCss = `:root {
  color-scheme: ${mode};
  --text-mix-blend-mode: ${isDark ? "plus-lighter" : "multiply"};
  ${css}
  ${v2}
}`

  document.getElementById(THEME_PRELOAD_STYLE_ID)?.remove()
  for (const id of LEGACY_THEME_PRELOAD_STYLE_IDS) document.getElementById(id)?.remove()
  ensureThemeStyleElement().textContent = fullCss
  document.documentElement.dataset.theme = themeId
  document.documentElement.dataset.colorScheme = mode
  document.documentElement.style.backgroundColor = tokens["background-base"]

  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute("content", tokens["background-base"])
}

function cacheThemeVariants(theme: DesktopTheme, themeId: string) {
  if (themeId === DEFAULT_THEME_ID) return
  for (const mode of ["light", "dark"] as const) {
    const isDark = mode === "dark"
    const variant = isDark ? theme.dark : theme.light
    const tokens = resolveThemeVariant(variant, isDark)
    const css = themeToCss(tokens)
    const v2 = themeV2ToCss(resolveThemeVariantV2(variant, isDark))
    write(isDark ? STORAGE_KEYS.THEME_CSS_DARK : STORAGE_KEYS.THEME_CSS_LIGHT, `${css}\n  ${v2}`)
  }
}

export const { use: useTheme, provider: ThemeProvider } = createSimpleContext({
  name: "Theme",
  init: (props: { defaultTheme?: string; onThemeApplied?: (theme: DesktopTheme, mode: "light" | "dark") => void }) => {
    const themeId = migrateStoredTheme(props.defaultTheme)
    const colorScheme = migrateStoredColorScheme()
    const mode = colorScheme === "system" ? getSystemMode() : colorScheme
    const [store, setStore] = createStore({
      themes: {
        [DEFAULT_THEME_ID]: mongolgptTheme,
      } as Record<string, DesktopTheme>,
      themeId,
      colorScheme,
      mode,
      previewThemeId: null as string | null,
      previewScheme: null as ColorScheme | null,
    })

    const loads = new Map<string, Promise<DesktopTheme | undefined>>()

    const load = (id: string) => {
      const next = normalizeThemeId(id)
      if (!next) return Promise.resolve(undefined)
      const hit = store.themes[next]
      if (hit) return Promise.resolve(hit)
      const pending = loads.get(next)
      if (pending) return pending
      const file = getFiles()[`./themes/${next}.json`]
      if (!file) return Promise.resolve(undefined)
      const task = file()
        .then((mod) => {
          const theme = mod.default
          setStore("themes", next, theme)
          return theme
        })
        .finally(() => {
          loads.delete(next)
        })
      loads.set(next, task)
      return task
    }

    const applyTheme = (theme: DesktopTheme, themeId: string, mode: "light" | "dark") => {
      applyThemeCss(theme, themeId, mode)
      props.onThemeApplied?.(theme, mode)
    }

    const ids = () => {
      const extra = Object.keys(store.themes)
        .filter((id) => !knownThemes().has(id))
        .sort()
      const all = themeIDs()
      if (extra.length === 0) return all
      return [...all, ...extra]
    }

    const loadThemes = () => Promise.all(themeIDs().map(load)).then(() => store.themes)

    const onStorage = (e: StorageEvent) => {
      if ((e.key === STORAGE_KEYS.THEME_ID || e.key === LEGACY_STORAGE_KEYS.THEME_ID) && e.newValue) {
        const next = normalizeThemeId(e.newValue)
        if (!next) return
        if (next !== DEFAULT_THEME_ID && !knownThemes().has(next) && !store.themes[next]) return
        if (e.key !== STORAGE_KEYS.THEME_ID || e.newValue !== next) write(STORAGE_KEYS.THEME_ID, next)
        if (e.key === LEGACY_STORAGE_KEYS.THEME_ID) drop(LEGACY_STORAGE_KEYS.THEME_ID)
        setStore("themeId", next)
        if (next === DEFAULT_THEME_ID) {
          clear()
          return
        }
        void load(next).then((theme) => {
          if (!theme || store.themeId !== next) return
          cacheThemeVariants(theme, next)
        })
      }
      if ((e.key === STORAGE_KEYS.COLOR_SCHEME || e.key === LEGACY_STORAGE_KEYS.COLOR_SCHEME) && e.newValue) {
        const scheme = normalizeColorScheme(e.newValue)
        if (e.key !== STORAGE_KEYS.COLOR_SCHEME || e.newValue !== scheme) write(STORAGE_KEYS.COLOR_SCHEME, scheme)
        if (e.key === LEGACY_STORAGE_KEYS.COLOR_SCHEME) drop(LEGACY_STORAGE_KEYS.COLOR_SCHEME)
        setStore("colorScheme", scheme)
        setStore("mode", scheme === "system" ? getSystemMode() : scheme)
      }
    }

    onMount(() => {
      makeEventListener(window, "storage", onStorage)

      const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)")
      const onMedia = () => {
        if (store.colorScheme !== "system") return
        setStore("mode", getSystemMode())
      }
      makeEventListener(mediaQuery, "change", onMedia)

      const savedTheme = migrateStoredTheme(props.defaultTheme)
      const savedScheme = migrateStoredColorScheme()
      if (savedTheme !== store.themeId) setStore("themeId", savedTheme)
      if (savedScheme !== store.colorScheme) setStore("colorScheme", savedScheme)
      setStore("mode", savedScheme === "system" ? getSystemMode() : savedScheme)
      void load(savedTheme).then((theme) => {
        if (!theme || store.themeId !== savedTheme) return
        cacheThemeVariants(theme, savedTheme)
      })
    })

    createEffect(() => {
      const theme = store.themes[store.themeId]
      if (!theme) return
      applyTheme(theme, store.themeId, store.mode)
    })

    const setTheme = (id: string) => {
      const next = normalizeThemeId(id)
      if (!next) {
        console.warn(`Theme "${id}" not found`)
        return
      }
      if (next !== DEFAULT_THEME_ID && !knownThemes().has(next) && !store.themes[next]) {
        console.warn(`Theme "${id}" not found`)
        return
      }
      setStore("themeId", next)
      if (next === DEFAULT_THEME_ID) {
        write(STORAGE_KEYS.THEME_ID, next)
        clear()
        return
      }
      void load(next).then((theme) => {
        if (!theme || store.themeId !== next) return
        cacheThemeVariants(theme, next)
        write(STORAGE_KEYS.THEME_ID, next)
      })
    }

    const setColorScheme = (scheme: ColorScheme) => {
      setStore("colorScheme", scheme)
      write(STORAGE_KEYS.COLOR_SCHEME, scheme)
      setStore("mode", scheme === "system" ? getSystemMode() : scheme)
    }

    return {
      themeId: () => store.themeId,
      colorScheme: () => store.colorScheme,
      mode: () => store.mode,
      ids,
      name: (id: string) => {
        const next = normalizeThemeId(id) ?? id
        return store.themes[next]?.name ?? names[next] ?? next
      },
      loadThemes,
      themes: () => store.themes,
      setTheme,
      setColorScheme,
      registerTheme: (theme: DesktopTheme) => {
        if (LEGACY_THEME_IDS.has(theme.id)) return
        setStore("themes", theme.id, theme)
      },
      previewTheme: (id: string) => {
        const next = normalizeThemeId(id)
        if (!next) return
        if (next !== DEFAULT_THEME_ID && !knownThemes().has(next) && !store.themes[next]) return
        setStore("previewThemeId", next)
        void load(next).then((theme) => {
          if (!theme || store.previewThemeId !== next) return
          const mode = store.previewScheme
            ? store.previewScheme === "system"
              ? getSystemMode()
              : store.previewScheme
            : store.mode
          applyTheme(theme, next, mode)
        })
      },
      previewColorScheme: (scheme: ColorScheme) => {
        setStore("previewScheme", scheme)
        const mode = scheme === "system" ? getSystemMode() : scheme
        const id = store.previewThemeId ?? store.themeId
        void load(id).then((theme) => {
          if (!theme) return
          if ((store.previewThemeId ?? store.themeId) !== id) return
          if (store.previewScheme !== scheme) return
          applyTheme(theme, id, mode)
        })
      },
      commitPreview: () => {
        if (store.previewThemeId) {
          setTheme(store.previewThemeId)
        }
        if (store.previewScheme) {
          setColorScheme(store.previewScheme)
        }
        setStore("previewThemeId", null)
        setStore("previewScheme", null)
      },
      cancelPreview: () => {
        setStore("previewThemeId", null)
        setStore("previewScheme", null)
        void load(store.themeId).then((theme) => {
          if (!theme) return
          applyTheme(theme, store.themeId, store.mode)
        })
      },
    }
  },
})
