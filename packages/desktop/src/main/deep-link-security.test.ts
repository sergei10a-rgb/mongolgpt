import { describe, expect, test } from "bun:test"
import { describeDeepLink, describeDeepLinks, isLocalBridgePairingDeepLink } from "./deep-link-security"

describe("desktop deep-link logging", () => {
  test("keeps only the action and strips sensitive query and fragment payloads", () => {
    const input =
      "mongolgpt://bridge/pair?account_id=usr_secret&state=secret-state&challenge=secret-challenge#prompt=private"
    const description = describeDeepLink(input)

    expect(description).toBe("bridge/pair")
    expect(description).not.toContain("usr_secret")
    expect(description).not.toContain("secret")
    expect(description).not.toContain("private")
  })

  test("describes only MongolGPT deep links", () => {
    expect(
      describeDeepLinks(["mongolgpt://account/login?token=secret", "https://attacker.test/path?secret=1"]),
    ).toEqual(["account/login", "invalid"])
    expect(describeDeepLink("not a url")).toBe("invalid")
  })

  test("routes only the exact local bridge pairing action to the main process", () => {
    expect(isLocalBridgePairingDeepLink("mongolgpt://bridge/pair?v=1&state=secret")).toBe(true)
    expect(isLocalBridgePairingDeepLink("mongolgpt://bridge/other?v=1")).toBe(false)
    expect(isLocalBridgePairingDeepLink("mongolgpt://account/login?token=secret")).toBe(false)
    expect(isLocalBridgePairingDeepLink("https://app.dev.mgpt.mn/bridge/pair")).toBe(false)
    expect(isLocalBridgePairingDeepLink("not a url")).toBe(false)
  })
})
