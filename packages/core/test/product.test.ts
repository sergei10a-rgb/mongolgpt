import { describe, expect, test } from "bun:test"
import { resolveProductServiceUrls } from "../src/product"

describe("product service urls", () => {
  test("routes stable releases to production services", () => {
    expect(resolveProductServiceUrls("latest")).toEqual({
      console: "https://mgpt.mn",
      auth: "https://auth.mgpt.mn",
      app: "https://app.mgpt.mn",
      docs: "https://docs.mgpt.mn/docs",
    })
    expect(resolveProductServiceUrls("prod")).toEqual(resolveProductServiceUrls("latest"))
  })

  test("routes repository builds to the dev services", () => {
    expect(resolveProductServiceUrls("main")).toEqual({
      console: "https://dev.mgpt.mn",
      auth: "https://auth.dev.mgpt.mn",
      app: "https://app.dev.mgpt.mn",
      docs: "https://docs.dev.mgpt.mn/docs",
    })
    expect(resolveProductServiceUrls("beta")).toEqual(resolveProductServiceUrls("main"))
  })

  test("keeps local and unknown builds on local services", () => {
    expect(resolveProductServiceUrls("local")).toEqual({
      console: "http://localhost:3000",
      auth: "http://localhost:3000/auth",
      app: "http://localhost:4444",
      docs: "http://localhost:4321/docs",
    })
    expect(resolveProductServiceUrls("feature-preview")).toEqual(resolveProductServiceUrls("local"))
  })
})
