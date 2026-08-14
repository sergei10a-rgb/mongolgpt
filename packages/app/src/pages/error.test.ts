import { describe, expect, test } from "bun:test"

const source = await Bun.file(new URL("./error.tsx", import.meta.url)).text()

describe("fatal error page", () => {
  test("keeps raw error details behind a collapsed technical-details control", () => {
    expect(source).toContain('import { Collapsible } from "@mongolgpt/ui/collapsible"')
    expect(source).toContain('<Collapsible class="w-full" variant="ghost">')
    expect(source).not.toContain('<Collapsible class="w-full" variant="ghost" defaultOpen>')
    expect(source).toContain("<Collapsible.Trigger")
    expect(source).toContain('<Collapsible.Content class="pt-2">')
    expect(source.indexOf("<Collapsible.Content")).toBeLessThan(source.indexOf("<TextField"))
    expect(source).toContain('language.t("error.page.title")')
    expect(source).toContain("language.t(errorDescriptionKey(props.error))")
  })
})
