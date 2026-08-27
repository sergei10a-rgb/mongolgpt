import { describe, expect, test } from "bun:test"
import { accountOnboardingStage, desktopAccountOnboardingReady } from "./account-onboarding-state"

describe("desktopAccountOnboardingReady", () => {
  const ready = {
    platform: "desktop",
    accountAvailable: true,
    localServer: true,
    storageReady: true,
    accountLoading: false,
    syncReady: true,
  }

  test("starts after account and local server state are ready without waiting for a managed model catalog", () => {
    expect(desktopAccountOnboardingReady(ready)).toBe(true)
  })

  test("waits for every required desktop state boundary", () => {
    expect(desktopAccountOnboardingReady({ ...ready, platform: "web" })).toBe(false)
    expect(desktopAccountOnboardingReady({ ...ready, accountAvailable: false })).toBe(false)
    expect(desktopAccountOnboardingReady({ ...ready, localServer: false })).toBe(false)
    expect(desktopAccountOnboardingReady({ ...ready, storageReady: false })).toBe(false)
    expect(desktopAccountOnboardingReady({ ...ready, accountLoading: true })).toBe(false)
    expect(desktopAccountOnboardingReady({ ...ready, syncReady: false })).toBe(false)
  })
})

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
