import * as i18n from "@solid-primitives/i18n"
import { createEffect, createMemo, createResource } from "solid-js"
import { createStore } from "solid-js/store"
import { createSimpleContext } from "@mongolgpt/ui/context"
import { Persist, persisted } from "@/utils/persist"
import { dict as en } from "@/i18n/en"
import { dict as mn } from "@/i18n/mn"
import { dict as uiEn } from "@mongolgpt/ui/i18n/en"
import { dict as uiMn } from "@mongolgpt/ui/i18n/mn"

export type Locale =
  | "en"
  | "zh"
  | "zht"
  | "ko"
  | "mn"
  | "de"
  | "es"
  | "fr"
  | "da"
  | "ja"
  | "pl"
  | "ru"
  | "uk"
  | "ar"
  | "no"
  | "br"
  | "th"
  | "bs"
  | "tr"

type RawDictionary = typeof en & typeof uiEn
type Dictionary = i18n.Flatten<RawDictionary>
type Source = { dict: Record<string, string> }

const LOCALE_COOKIE = "mongolgpt_locale"
const LEGACY_LOCALE_COOKIES = ["oc_locale"] as const

function localeCookie(name: string, locale: Locale) {
  return `${name}=${encodeURIComponent(locale)}; Path=/; Max-Age=31536000; SameSite=Lax`
}

function clearCookie(name: string) {
  return `${name}=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax`
}

const LOCALES: readonly Locale[] = [
  "en",
  "zh",
  "zht",
  "ko",
  "mn",
  "de",
  "es",
  "fr",
  "da",
  "ja",
  "pl",
  "ru",
  "uk",
  "bs",
  "ar",
  "no",
  "br",
  "th",
  "tr",
]

const DEFAULT_LOCALE: Locale = "mn"

function parseLocale(value: string | undefined): Locale | undefined {
  return LOCALES.includes(value as Locale) ? (value as Locale) : undefined
}

export function readLocaleCookie() {
  if (typeof document !== "object") return
  const values = new Map(
    document.cookie.split(";").flatMap((entry) => {
      const index = entry.indexOf("=")
      if (index === -1) return []
      const key = entry.slice(0, index).trim()
      try {
        return [[key, decodeURIComponent(entry.slice(index + 1))] as const]
      } catch {
        return []
      }
    }),
  )
  return (
    parseLocale(values.get(LOCALE_COOKIE)) ??
    LEGACY_LOCALE_COOKIES.map((name) => parseLocale(values.get(name))).find((locale) => locale !== undefined)
  )
}

export function syncLocaleCookie(locale: Locale) {
  if (typeof document !== "object") return
  document.cookie = localeCookie(LOCALE_COOKIE, locale)
  for (const name of LEGACY_LOCALE_COOKIES) document.cookie = clearCookie(name)
}

const INTL: Record<Locale, string> = {
  en: "en",
  zh: "zh-Hans",
  zht: "zh-Hant",
  ko: "ko",
  mn: "mn-MN",
  de: "de",
  es: "es",
  fr: "fr",
  da: "da",
  ja: "ja",
  pl: "pl",
  ru: "ru",
  uk: "uk",
  ar: "ar",
  no: "nb-NO",
  br: "pt-BR",
  th: "th",
  bs: "bs",
  tr: "tr",
}

const LABEL_KEY: Record<Locale, keyof Dictionary> = {
  en: "language.en",
  zh: "language.zh",
  zht: "language.zht",
  ko: "language.ko",
  mn: "language.mn",
  de: "language.de",
  es: "language.es",
  fr: "language.fr",
  da: "language.da",
  ja: "language.ja",
  pl: "language.pl",
  ru: "language.ru",
  uk: "language.uk",
  ar: "language.ar",
  no: "language.no",
  br: "language.br",
  th: "language.th",
  bs: "language.bs",
  tr: "language.tr",
}

const base = i18n.flatten({ ...en, ...uiEn })
const mnBase = { ...base, ...i18n.flatten({ ...mn, ...uiMn }) } as Dictionary
const dicts = new Map<Locale, Dictionary>([
  ["en", base],
  ["mn", mnBase],
])

const merge = (app: Promise<Source>, ui: Promise<Source>) =>
  Promise.all([app, ui]).then(([a, b]) => ({ ...base, ...i18n.flatten({ ...a.dict, ...b.dict }) }) as Dictionary)

const loaders: Record<Exclude<Locale, "en">, () => Promise<Dictionary>> = {
  zh: () => merge(import("@/i18n/zh"), import("@mongolgpt/ui/i18n/zh")),
  zht: () => merge(import("@/i18n/zht"), import("@mongolgpt/ui/i18n/zht")),
  ko: () => merge(import("@/i18n/ko"), import("@mongolgpt/ui/i18n/ko")),
  mn: () => Promise.resolve(mnBase),
  de: () => merge(import("@/i18n/de"), import("@mongolgpt/ui/i18n/de")),
  es: () => merge(import("@/i18n/es"), import("@mongolgpt/ui/i18n/es")),
  fr: () => merge(import("@/i18n/fr"), import("@mongolgpt/ui/i18n/fr")),
  da: () => merge(import("@/i18n/da"), import("@mongolgpt/ui/i18n/da")),
  ja: () => merge(import("@/i18n/ja"), import("@mongolgpt/ui/i18n/ja")),
  pl: () => merge(import("@/i18n/pl"), import("@mongolgpt/ui/i18n/pl")),
  ru: () => merge(import("@/i18n/ru"), import("@mongolgpt/ui/i18n/ru")),
  uk: () => merge(import("@/i18n/uk"), import("@mongolgpt/ui/i18n/uk")),
  ar: () => merge(import("@/i18n/ar"), import("@mongolgpt/ui/i18n/ar")),
  no: () => merge(import("@/i18n/no"), import("@mongolgpt/ui/i18n/no")),
  br: () => merge(import("@/i18n/br"), import("@mongolgpt/ui/i18n/br")),
  th: () => merge(import("@/i18n/th"), import("@mongolgpt/ui/i18n/th")),
  bs: () => merge(import("@/i18n/bs"), import("@mongolgpt/ui/i18n/bs")),
  tr: () => merge(import("@/i18n/tr"), import("@mongolgpt/ui/i18n/tr")),
}

function loadDict(locale: Locale) {
  const hit = dicts.get(locale)
  if (hit) return Promise.resolve(hit)
  if (locale === "en") return Promise.resolve(base)
  const load = loaders[locale]
  return load().then((next: Dictionary) => {
    dicts.set(locale, next)
    return next
  })
}

export function loadLocaleDict(locale: Locale) {
  return loadDict(locale).then(() => undefined)
}

function detectLocale(): Locale {
  return DEFAULT_LOCALE
}

export function normalizeLocale(value: string): Locale {
  return parseLocale(value) ?? DEFAULT_LOCALE
}

function migrateLanguage(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value
  const next = value as Record<string, unknown>
  if (next.locale === "en" && next.source !== "user" && next.defaultLocale !== DEFAULT_LOCALE) {
    return { ...next, locale: DEFAULT_LOCALE, defaultLocale: DEFAULT_LOCALE }
  }
  return { ...next, defaultLocale: next.defaultLocale ?? DEFAULT_LOCALE }
}

function readStoredLocale() {
  if (typeof localStorage !== "object") return
  try {
    const raw = localStorage.getItem("mongolgpt.global.dat:language")
    if (!raw) return
    const next = migrateLanguage(JSON.parse(raw)) as { locale?: string }
    if (typeof next?.locale !== "string") return
    return normalizeLocale(next.locale)
  } catch {
    return
  }
}

const warm = readStoredLocale() ?? readLocaleCookie() ?? detectLocale()
if (warm !== "en") void loadDict(warm)

export const { use: useLanguage, provider: LanguageProvider } = createSimpleContext({
  name: "Language",
  gate: false,
  init: (props: { locale?: Locale }) => {
    const initial = props.locale ?? readStoredLocale() ?? readLocaleCookie() ?? detectLocale()
    const [store, setStore, _, ready] = persisted(
      { ...Persist.global("language", ["language.v1"]), migrate: migrateLanguage },
      createStore({
        locale: initial,
        defaultLocale: DEFAULT_LOCALE,
        source: "system" as "system" | "user",
      }),
    )

    const locale = createMemo<Locale>(() => normalizeLocale(store.locale))
    const intl = createMemo(() => INTL[locale()])

    const [dict] = createResource(locale, loadDict, {
      initialValue: dicts.get(initial) ?? base,
    })

    const t = i18n.translator(() => dict() ?? base, i18n.resolveTemplate) as (
      key: keyof Dictionary,
      params?: Record<string, string | number | boolean>,
    ) => string

    const label = (value: Locale) => t(LABEL_KEY[value])

    createEffect(() => {
      if (typeof document !== "object") return
      document.documentElement.lang = locale()
      syncLocaleCookie(locale())
    })

    return {
      ready,
      locale,
      intl,
      locales: LOCALES,
      label,
      t,
      setLocale(next: Locale) {
        setStore({ locale: normalizeLocale(next), defaultLocale: DEFAULT_LOCALE, source: "user" })
      },
    }
  },
})
