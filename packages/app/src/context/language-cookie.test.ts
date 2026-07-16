import { beforeEach, describe, expect, test } from "bun:test"
import { readLocaleCookie, syncLocaleCookie } from "./language"

beforeEach(() => {
  ;(window as typeof window & { happyDOM: { setURL(url: string): void } }).happyDOM.setURL("https://mongolgpt.local/")
  document.cookie = "mongolgpt_locale=; Path=/; Max-Age=0"
  document.cookie = "oc_locale=; Path=/; Max-Age=0"
})

describe("locale cookie identity migration", () => {
  test("reads a legacy locale and stores it under the canonical name", () => {
    document.cookie = "oc_locale=en; Path=/"

    expect(readLocaleCookie()).toBe("en")
    syncLocaleCookie("en")

    expect(document.cookie).toContain("mongolgpt_locale=en")
    expect(document.cookie).not.toContain("oc_locale=")
  })

  test("prefers the canonical locale cookie", () => {
    document.cookie = "oc_locale=en; Path=/"
    document.cookie = "mongolgpt_locale=mn; Path=/"

    expect(readLocaleCookie()).toBe("mn")
  })
})
