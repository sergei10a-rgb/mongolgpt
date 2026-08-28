import { expect, test } from "bun:test"
import { docs, localeFromRequest, LOCALES } from "../src/lib/language"
import { i18n } from "../src/i18n"
import { dict as en } from "../src/i18n/en"
import { dict as mn } from "../src/i18n/mn"

const allowedMongolianIdenticalKeys = new Set<keyof typeof en>([
  "nav.github",
  "nav.discord",
  "nav.x",
  "nav.logoAlt",
  "footer.github",
  "footer.feishu",
  "footer.discord",
  "footer.x",
  "notFound.github",
  "notFound.discord",
  "pricing.plan.free.name",
  "pricing.plan.basic.name",
  "pricing.plan.pro.name",
  "pricing.plan.max.name",
  "home.what.copilot.title",
  "home.what.chatgptPlus.title",
  "home.growth.accountValue",
  "home.growth.clientsValue",
  "home.growth.providersValue",
  "home.faq.a8.mitLicense",
  "gateway.api.error.providerFailure",
  "gateway.api.error.internalServer",
  "workspace.usage.subscription",
  "workspace.usage.byok",
  "workspace.billing.alipay",
  "workspace.billing.wechat",
  "workspace.monthlyLimit.placeholder",
  "download.section.terminal",
  "download.platform.macosAppleSilicon",
  "download.platform.macosIntel",
  "download.platform.windowsX64",
  "download.platform.linuxDeb",
  "download.platform.linuxRpm",
])

const placeholders = (value: string) => value.match(/{{[^}]+}}/g)?.sort() ?? []

const freeAutoAccountMarkers = {
  mn: /бүртгэлээр нэвтэр/,
  en: /Sign in.*account/,
  zh: /登录.*账户/,
  zht: /登入.*帳號/,
  ko: /계정에 로그인/,
  de: /Melde dich.*Konto an/,
  es: /Inicia sesión.*cuenta/,
  fr: /Connectez-vous.*compte/,
  it: /Accedi.*account/,
  da: /Log ind.*konto/,
  ja: /アカウントにサインイン/,
  pl: /Zaloguj się.*konto/,
  ru: /Войдите.*аккаунт/,
  uk: /Увійдіть.*обліковий запис/,
  ar: /سجّل الدخول.*حساب/,
  no: /Logg inn.*konto/,
  br: /Entre.*conta/,
  th: /เข้าสู่ระบบบัญชี/,
  tr: /hesabınızda oturum açın/,
} satisfies Record<(typeof LOCALES)[number], RegExp>

test("бүх хэлний docs холбоос Монгол каноник замыг ашиглана", () => {
  expect(docs("mn", "/docs/providers")).toBe("/docs/providers")
  expect(docs("en", "/docs/providers")).toBe("/docs/providers")
  expect(docs("zh", "/docs")).toBe("/docs")
  expect(docs("mn", "/docs/mn/providers")).toBe("/docs/providers")
  expect(docs("en", "/docs/en/")).toBe("/docs/")
})

test("locale dictionaries return English and Mongolian billing/error copy", () => {
  expect(i18n("en")["gateway.api.error.missingApiKey"]).toBe("Missing API key.")
  expect(i18n("mn")["gateway.api.error.missingApiKey"]).toBe("API түлхүүр дутуу байна.")
  expect(Object.keys(mn).sort()).toEqual(Object.keys(en).sort())
})

test("Монгол каталог англи утгыг зөвхөн техникийн нэр томьёонд хадгална", () => {
  for (const [key, english] of Object.entries(en)) {
    const typed = key as keyof typeof en
    const mongolian = mn[typed]
    expect(placeholders(mongolian)).toEqual(placeholders(english))
    if (mongolian === english) expect(allowedMongolianIdenticalKeys.has(typed), key).toBe(true)
  }
})

test("шинэ хэрэглэгчийн анхдагч хэл Монгол байна", () => {
  const request = new Request("https://mgpt.mn/", {
    headers: { "accept-language": "en-US,en;q=0.9" },
  })
  expect(localeFromRequest(request)).toBe("mn")
})

test("хэрэглэгчийн илэрхий сонгосон хэлийг хадгална", () => {
  expect(localeFromRequest(new Request("https://mgpt.mn/en/pricing"))).toBe("en")
  expect(
    localeFromRequest(
      new Request("https://mgpt.mn/", {
        headers: { cookie: "mongolgpt_locale=en" },
      }),
    ),
  ).toBe("en")
})

test("бүх хэлний Free Auto тайлбар MongolGPT бүртгэлийн бодлоготой таарна", () => {
  for (const locale of LOCALES) {
    const description = i18n(locale)["home.faq.a3.p1"]
    expect(description, locale).toContain("Free Auto")
    expect(description, locale).toMatch(freeAutoAccountMarkers[locale])
  }
})
