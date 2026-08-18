import { describe, expect, test } from "bun:test"
import { dict as en } from "./en"
import { dict as ar } from "./ar"
import { dict as br } from "./br"
import { dict as bs } from "./bs"
import { dict as da } from "./da"
import { dict as de } from "./de"
import { dict as es } from "./es"
import { dict as fr } from "./fr"
import { dict as ja } from "./ja"
import { dict as ko } from "./ko"
import { dict as mn } from "./mn"
import { dict as no } from "./no"
import { dict as pl } from "./pl"
import { dict as ru } from "./ru"
import { dict as uk } from "./uk"
import { dict as th } from "./th"
import { dict as zh } from "./zh"
import { dict as zht } from "./zht"
import { dict as tr } from "./tr"

const locales = [ar, br, bs, da, de, es, fr, ja, ko, mn, no, pl, ru, uk, th, tr, zh, zht]
const keys = ["command.session.previous.unseen", "command.session.next.unseen"] as const
const allowedMongolianIdenticalKeys = new Set<keyof typeof en>([
  "command.category.mcp",
  "provider.connect.nvidia.step1.link",
  "provider.custom.description.suffix",
  "provider.custom.field.providerID.placeholder",
  "provider.custom.field.baseURL.placeholder",
  "provider.custom.models.id.label",
  "provider.custom.models.id.placeholder",
  "provider.custom.headers.key.placeholder",
  "provider.custom.headers.value.placeholder",
  "onboarding.providers.freeAuto.title",
  "model.provider.anthropic",
  "model.provider.openai",
  "model.provider.google",
  "model.provider.xai",
  "model.provider.meta",
  "common.loading.ellipsis",
  "prompt.slash.badge.mcp",
  "dialog.server.add.placeholder",
  "wsl.server.label",
  "wsl.onboarding.step.mongolgpt",
  "language.zh",
  "language.zht",
  "language.ko",
  "language.mn",
  "language.ja",
  "language.ru",
  "language.ar",
  "language.uk",
  "language.th",
  "session.header.open.finder",
  "session.header.open.app.cursor",
  "session.header.open.app.zed",
  "session.header.open.app.textmate",
  "session.header.open.app.antigravity",
  "session.header.open.app.iterm2",
  "session.header.open.app.ghostty",
  "session.header.open.app.warp",
  "session.header.open.app.xcode",
  "session.header.open.app.androidStudio",
  "session.header.open.app.sublimeText",
  "session.header.open.app.powershell",
  "status.popover.tab.mcp",
  "status.popover.tab.lsp",
  "common.key.esc",
  "common.key.ctrl",
  "common.key.alt",
  "common.key.shift",
  "common.key.meta",
  "common.key.tab",
  "debugBar.nav.label",
  "debugBar.fps.label",
  "debugBar.frame.label",
  "debugBar.jank.label",
  "debugBar.long.label",
  "debugBar.delay.label",
  "debugBar.inp.label",
  "debugBar.cls.label",
  "debugBar.mem.label",
  "settings.desktop.section.wsl",
  "sound.option.staplebops01",
  "sound.option.staplebops02",
  "sound.option.staplebops03",
  "sound.option.staplebops04",
  "sound.option.staplebops05",
  "sound.option.staplebops06",
  "sound.option.staplebops07",
  "sound.option.nope01",
  "sound.option.nope02",
  "sound.option.nope03",
  "sound.option.nope04",
  "sound.option.nope05",
  "sound.option.nope06",
  "sound.option.nope07",
  "sound.option.nope08",
  "sound.option.nope09",
  "sound.option.nope10",
  "sound.option.nope11",
  "sound.option.nope12",
  "sound.option.yup01",
  "sound.option.yup02",
  "sound.option.yup03",
  "sound.option.yup04",
  "sound.option.yup05",
  "sound.option.yup06",
  "settings.mcp.title",
  "settings.permissions.tool.lsp.title",
  "settings.imports.operation.mcp",
])

const placeholders = (value: string) => value.match(/{{[^}]+}}/g)?.sort() ?? []

describe("i18n parity", () => {
  test("Mongolian covers the complete English catalog", () => {
    expect(Object.keys(mn).sort()).toEqual(Object.keys(en).sort())
  })

  test("Mongolian does not silently reuse English outside technical terms", () => {
    for (const [key, english] of Object.entries(en)) {
      const typed = key as keyof typeof en
      const mongolian = mn[typed]
      expect(placeholders(mongolian)).toEqual(placeholders(english))
      if (mongolian === english) expect(allowedMongolianIdenticalKeys.has(typed)).toBe(true)
    }
  })

  test("non-English locales translate targeted unseen session keys", () => {
    for (const locale of locales) {
      for (const key of keys) {
        expect(locale[key]).toBeDefined()
        expect(locale[key]).not.toBe(en[key])
      }
    }
  })
})
