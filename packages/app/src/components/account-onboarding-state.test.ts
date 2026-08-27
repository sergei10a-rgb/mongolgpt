import { describe, expect, test } from "bun:test"
import { accountOnboardingStage } from "./account-onboarding-state"

describe("accountOnboardingStage", () => {
  test("starts with MongolGPT account login", () => {
    expect(accountOnboardingStage({ ready: true, signedIn: false, connected: false, completed: false })).toBe("account")
  })

  test("requires an active workspace after account login", () => {
    expect(accountOnboardingStage({ ready: true, signedIn: true, connected: false, completed: false })).toBe(
      "workspace",
    )
  })

  test("shows optional provider setup after login", () => {
    expect(accountOnboardingStage({ ready: true, signedIn: true, connected: true, completed: false })).toBe("providers")
  })

  test("waits for state and stays hidden after completion", () => {
    expect(
      accountOnboardingStage({ ready: false, signedIn: false, connected: false, completed: false }),
    ).toBeUndefined()
    expect(accountOnboardingStage({ ready: true, signedIn: true, connected: true, completed: true })).toBeUndefined()
  })
})
