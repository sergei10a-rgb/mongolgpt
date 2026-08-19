import { expect, test } from "bun:test"
import { docs, localeFromRequest } from "../src/lib/language"
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
  "home.faq.a8.mitLicense",
  "zen.api.error.providerFailure",
  "zen.api.error.internalServer",
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

test("бүх хэлний docs холбоос Монгол каноник замыг ашиглана", () => {
  expect(docs("mn", "/docs/providers")).toBe("/docs/providers")
  expect(docs("en", "/docs/providers")).toBe("/docs/providers")
  expect(docs("zh", "/docs")).toBe("/docs")
  expect(docs("mn", "/docs/mn/providers")).toBe("/docs/providers")
  expect(docs("en", "/docs/en/")).toBe("/docs/")
})

test("locale dictionaries return English and Mongolian billing/error copy", () => {
  expect(i18n("en")["zen.api.error.missingApiKey"]).toBe("Missing API key.")
  expect(i18n("mn")["zen.api.error.missingApiKey"]).toBe("API түлхүүр дутуу байна.")
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
