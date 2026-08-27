import { describe, expect, test } from "bun:test"
import { createLocalBridgePairing } from "@mongolgpt/local-bridge"
import {
  createDesktopLocalBridgePairingController,
  type DesktopLocalBridgePairingDependencies,
} from "./local-bridge-pairing"

const origin = "https://app.dev.mgpt.mn"
const accountID = "usr_local_bridge"
const verifierBytes = new Uint8Array(32).fill(7)

async function pairing(overrides: Partial<Parameters<typeof createLocalBridgePairing>[0]> = {}) {
  return createLocalBridgePairing({
    origin,
    accountID,
    randomBytes: () => verifierBytes,
    ...overrides,
  })
}

function dependencies(overrides: Partial<DesktopLocalBridgePairingDependencies> = {}) {
  const opened: string[] = []
  const authorized: string[] = []
  const value: DesktopLocalBridgePairingDependencies = {
    allowedOrigins: [origin],
    currentAccount: async () => ({ id: accountID }),
    confirm: async () => true,
    authorize: async (request) => {
      authorized.push(request.accountID)
      return { port: 45_321, code: "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM", expiresAt: 123 }
    },
    openExternal: async (url) => {
      opened.push(url)
    },
    ...overrides,
  }
  return { value, opened, authorized }
}

describe("desktop local bridge pairing controller", () => {
  test("checks the account, asks for approval, and opens an origin/state-bound callback", async () => {
    const request = await pairing()
    const { value, opened, authorized } = dependencies()
    const result = await createDesktopLocalBridgePairingController(value).handle(request.url)

    expect(result).toEqual({ status: "opened" })
    expect(authorized).toEqual([accountID])
    expect(opened).toHaveLength(1)
    const callback = new URL(opened[0])
    expect(callback.origin).toBe(origin)
    expect(callback.hash).toContain(`state=${request.request.state}`)
    expect(callback.hash).toContain("port=45321")
    expect(callback.hash).toContain("code=AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM")
  })

  test("rejects malformed and disallowed-origin requests without invoking dependencies", async () => {
    const request = await pairing()
    const { value, authorized, opened } = dependencies({ allowedOrigins: ["https://app.mgpt.mn"] })
    const controller = createDesktopLocalBridgePairingController(value)

    for (const value of ["not a URL", request.url]) {
      await expect(controller.handle(value)).rejects.toMatchObject({ code: "invalid_request" })
    }
    expect(authorized).toEqual([])
    expect(opened).toEqual([])
  })

  test("requires an authenticated account and an exact account match", async () => {
    const request = await pairing()
    await expect(
      createDesktopLocalBridgePairingController(dependencies({ currentAccount: async () => null }).value).handle(
        request.url,
      ),
    ).rejects.toMatchObject({ code: "not_authenticated" })
    await expect(
      createDesktopLocalBridgePairingController(
        dependencies({ currentAccount: async () => ({ id: "usr_other_account" }) }).value,
      ).handle(request.url),
    ).rejects.toMatchObject({ code: "account_mismatch" })
  })

  test("does not authorize or open when native confirmation denies", async () => {
    const request = await pairing()
    const { value, authorized, opened } = dependencies({ confirm: async () => false })

    await expect(createDesktopLocalBridgePairingController(value).handle(request.url)).resolves.toEqual({
      status: "denied",
    })
    expect(authorized).toEqual([])
    expect(opened).toEqual([])
  })

  test("rechecks the account after native confirmation before authorizing", async () => {
    const request = await pairing()
    let checks = 0
    const { value, authorized, opened } = dependencies({
      currentAccount: async () => ({ id: checks++ === 0 ? accountID : "usr_changed_account" }),
    })

    await expect(createDesktopLocalBridgePairingController(value).handle(request.url)).rejects.toMatchObject({
      code: "account_mismatch",
    })
    expect(authorized).toEqual([])
    expect(opened).toEqual([])
  })

  test("sanitizes authorization and open failures", async () => {
    const request = await pairing()
    const sensitive = `${request.url} ${request.verifier}`
    for (const overrides of [
      { authorize: async () => Promise.reject(new Error(sensitive)) },
      { openExternal: async () => Promise.reject(new Error(sensitive)) },
    ]) {
      const error = await createDesktopLocalBridgePairingController(dependencies(overrides).value)
        .handle(request.url)
        .catch((value: unknown) => value)
      expect(error).toMatchObject({ code: "operation_failed" })
      expect(error).toBeInstanceOf(Error)
      if (!(error instanceof Error)) throw new Error("Expected an Error")
      expect(error.message).not.toContain(request.url)
      expect(error.message).not.toContain(request.verifier)
    }
  })
})
