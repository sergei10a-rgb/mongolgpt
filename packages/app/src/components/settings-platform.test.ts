import { describe, expect, test } from "bun:test"
import { settingsPlatformLabels } from "./settings-platform"

describe("settings platform labels", () => {
  test("uses web labels in the hosted app", () => {
    expect(settingsPlatformLabels("web")).toEqual({
      section: "settings.section.web",
      app: "app.name.web",
    })
  })

  test("keeps desktop labels in the installed app", () => {
    expect(settingsPlatformLabels("desktop")).toEqual({
      section: "settings.section.desktop",
      app: "app.name.desktop",
    })
  })
})
