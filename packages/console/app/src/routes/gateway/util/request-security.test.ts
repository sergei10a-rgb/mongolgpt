import { describe, expect, test } from "bun:test"
import { authenticatedRateLimitIdentity, sanitizeProviderRequestHeaders } from "./request-security"

describe("provider request security", () => {
  test("removes caller credentials before an upstream provider adds its own", () => {
    const headers = sanitizeProviderRequestHeaders(
      new Headers({
        authorization: "Bearer mongolgpt-account-token",
        "proxy-authorization": "Basic secret",
        cookie: "session=secret",
        "x-api-key": "caller-secret",
        "api-key": "caller-secret",
        "x-goog-api-key": "caller-secret",
        "x-access-token": "caller-secret",
        "x-auth-token": "caller-secret",
        "x-org-id": "workspace-1",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "user-agent": "MongolGPT",
      }),
    )

    expect(Object.fromEntries(headers)).toEqual({
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    })
  })

  test("uses stable account identity across access-token refreshes", () => {
    const first = authenticatedRateLimitIdentity({ workspaceID: "workspace-1", userID: "user-1" }, "first-access-token")
    const refreshed = authenticatedRateLimitIdentity(
      { workspaceID: "workspace-1", userID: "user-1" },
      "refreshed-access-token",
    )

    expect(first).toBe(refreshed)
    expect(first).toBe("workspace:workspace-1:user:user-1")
    expect(authenticatedRateLimitIdentity(undefined, "service-key")).toBe("service-key")
  })
})
