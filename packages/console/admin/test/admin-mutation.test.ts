import { describe, expect, test } from "bun:test"
import { AdminMutationRequestError, requireSameOriginAdminMutation } from "../src/lib/admin-mutation"

function request(input?: { origin?: string; method?: string; fetchSite?: string; contentType?: string }) {
  const headers = new Headers()
  if (input?.origin) headers.set("origin", input.origin)
  if (input?.fetchSite) headers.set("sec-fetch-site", input.fetchSite)
  headers.set("content-type", input?.contentType ?? "application/x-www-form-urlencoded")
  return new Request("https://admin.dev.mgpt.mn/_server", {
    method: input?.method ?? "POST",
    headers,
  })
}

describe("admin mutation request", () => {
  test("accepts a same-origin browser form POST", () => {
    expect(() =>
      requireSameOriginAdminMutation(
        request({
          origin: "https://admin.dev.mgpt.mn",
          fetchSite: "same-origin",
        }),
      ),
    ).not.toThrow()
  })

  test("rejects missing, cross-origin, and cross-site requests", () => {
    expect(() => requireSameOriginAdminMutation(request())).toThrow(AdminMutationRequestError)
    expect(() => requireSameOriginAdminMutation(request({ origin: "https://attacker.example" }))).toThrow(
      AdminMutationRequestError,
    )
    expect(() =>
      requireSameOriginAdminMutation(
        request({
          origin: "https://admin.dev.mgpt.mn",
          fetchSite: "cross-site",
        }),
      ),
    ).toThrow(AdminMutationRequestError)
  })

  test("rejects non-form and non-POST requests", () => {
    expect(() =>
      requireSameOriginAdminMutation(
        request({
          origin: "https://admin.dev.mgpt.mn",
          method: "GET",
        }),
      ),
    ).toThrow(AdminMutationRequestError)
    expect(() =>
      requireSameOriginAdminMutation(
        request({
          origin: "https://admin.dev.mgpt.mn",
          contentType: "application/json",
        }),
      ),
    ).toThrow(AdminMutationRequestError)
  })
})
