import { describe, expect, test } from "bun:test"
import { isHostedAppOrigin, resolveHostedServiceUrls } from "../src/service-urls"

describe("hosted service URL contract", () => {
  test("derives every production service from one root domain", () => {
    expect(resolveHostedServiceUrls("mgpt.mn", "production")).toEqual({
      rootDomain: "mgpt.mn",
      stage: "production",
      stageDomain: "mgpt.mn",
      console: "https://mgpt.mn",
      support: "https://mgpt.mn/support",
      auth: "https://auth.mgpt.mn",
      app: "https://app.mgpt.mn",
      docs: "https://docs.mgpt.mn/docs",
      runtime: "https://runtime.mgpt.mn",
      payment: "https://pay.mgpt.mn",
      admin: "https://admin.mgpt.mn",
      share: "https://share.mgpt.mn",
    })
  })

  test("puts non-production services below the exact stage subdomain", () => {
    expect(resolveHostedServiceUrls("mgpt.mn", "dev")).toEqual({
      rootDomain: "mgpt.mn",
      stage: "dev",
      stageDomain: "dev.mgpt.mn",
      console: "https://dev.mgpt.mn",
      support: "https://dev.mgpt.mn/support",
      auth: "https://auth.dev.mgpt.mn",
      app: "https://app.dev.mgpt.mn",
      docs: "https://docs.dev.mgpt.mn/docs",
      runtime: "https://runtime.dev.mgpt.mn",
      payment: "https://pay.dev.mgpt.mn",
      admin: "https://admin.dev.mgpt.mn",
      share: "https://share.dev.mgpt.mn",
    })
  })

  test("rejects non-canonical domains and stages", () => {
    for (const domain of ["", "MGPT.MN", " mgpt.mn", "https://mgpt.mn", "mgpt..mn", "localhost"]) {
      expect(() => resolveHostedServiceUrls(domain, "dev")).toThrow()
    }
    for (const stage of ["", "DEV", " dev", "feature/one", "-dev"]) {
      expect(() => resolveHostedServiceUrls("mgpt.mn", stage)).toThrow()
    }
  })

  test("recognizes only canonical production and single-stage app origins", () => {
    for (const origin of [
      "https://app.mgpt.mn",
      "https://app.dev.mgpt.mn",
      "https://app.beta.mgpt.mn",
      "https://app.preview-12.mgpt.mn",
    ]) {
      expect(isHostedAppOrigin(origin, "mgpt.mn")).toBe(true)
    }
    for (const origin of [
      "http://app.dev.mgpt.mn",
      "https://app.preview.evil.mgpt.mn",
      "https://app.mgpt.mn.evil.example",
      "https://app.dev.mgpt.mn/path",
      "https://user@app.dev.mgpt.mn",
    ]) {
      expect(isHostedAppOrigin(origin, "mgpt.mn")).toBe(false)
    }
  })
})
