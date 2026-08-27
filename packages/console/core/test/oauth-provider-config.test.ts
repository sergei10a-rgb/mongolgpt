import { describe, expect, test } from "bun:test"
import { inspectOAuthProviderConfiguration } from "../src/oauth-provider-config"

describe("OAuth provider configuration", () => {
  test("allows GitHub-only dev authentication", () => {
    expect(
      inspectOAuthProviderConfiguration({
        stage: "dev",
        githubClientID: "github-client",
        githubClientSecret: "github-secret",
      }),
    ).toEqual({ github: true, google: false, issues: [] })
  })

  test("allows Google-only dev authentication", () => {
    expect(
      inspectOAuthProviderConfiguration({
        stage: "dev",
        googleClientID: "google-client.apps.googleusercontent.com",
      }),
    ).toEqual({ github: false, google: true, issues: [] })
  })

  test("rejects a partial GitHub provider even when Google is enabled", () => {
    const result = inspectOAuthProviderConfiguration({
      stage: "dev",
      githubClientID: "github-client",
      googleClientID: "google-client.apps.googleusercontent.com",
    })
    expect(result.github).toBe(false)
    expect(result.google).toBe(true)
    expect(result.issues.join(" ")).toContain("GITHUB_CLIENT_SECRET_CONSOLE")
  })

  test("requires both providers in production", () => {
    const result = inspectOAuthProviderConfiguration({
      stage: "production",
      githubClientID: "github-client",
      githubClientSecret: "github-secret",
    })
    expect(result.issues).toContain("Production орчинд Google OAuth provider бүрэн тохирсон байна.")
  })
})
