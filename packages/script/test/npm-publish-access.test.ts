import { describe, expect, test } from "bun:test"
import { npmPublishCliPackages, npmPublishPlatformPackages, verifyNpmPublishAccess } from "../src/npm-publish-access"

type Result = { status: number; stdout: string; stderr: string }

function runner(input: {
  owner?: string
  role?: "owner" | "admin" | "developer"
  access?: Partial<Record<(typeof npmPublishPlatformPackages)[number], "read-only" | "read-write">>
  registryStatus?: Partial<Record<(typeof npmPublishPlatformPackages)[number], number>>
  fail?: (args: readonly string[]) => boolean
}) {
  const calls: string[][] = []
  const lookups: string[] = []
  const owner = input.owner ?? "sergei9a"
  return {
    calls,
    lookups,
    registryStatus: async (name: string) => {
      lookups.push(name)
      return input.registryStatus?.[name as (typeof npmPublishPlatformPackages)[number]] ?? 404
    },
    run: async (args: readonly string[]): Promise<Result> => {
      calls.push([...args])
      if (input.fail?.(args)) return { status: 1, stdout: "", stderr: "sensitive registry response" }
      if (args[0] === "whoami") return { status: 0, stdout: `${owner}\n`, stderr: "" }
      if (args[0] === "view")
        return { status: 0, stdout: JSON.stringify([`${owner} <private@example.com>`]), stderr: "" }
      if (args[0] === "org") {
        return { status: 0, stdout: JSON.stringify(input.role ? { [owner]: input.role } : {}), stderr: "" }
      }
      if (args[0] === "access") {
        const access = input.access ?? Object.fromEntries(npmPublishPlatformPackages.map((name) => [name, "read-write"]))
        return { status: 0, stdout: JSON.stringify(access), stderr: "" }
      }
      return { status: 2, stdout: "", stderr: "unexpected command" }
    },
  }
}

describe("npm publish access preflight", () => {
  test("verifies every existing CLI package before the scoped organization", async () => {
    const mock = runner({ role: "owner" })
    await expect(
      verifyNpmPublishAccess({ token: "secret", run: mock.run, registryStatus: mock.registryStatus }),
    ).resolves.toEqual({
      owner: "sergei9a",
      role: "owner",
      cliPackages: npmPublishCliPackages.length,
      platformPackages: 3,
    })
    expect(mock.calls.filter((args) => args[0] === "view")).toHaveLength(npmPublishCliPackages.length)
    expect(mock.calls.at(-2)?.slice(0, 4)).toEqual(["org", "ls", "mongolgpt", "--json"])
    expect(mock.calls.at(-1)?.slice(0, 5)).toEqual(["access", "list", "packages", "@mongolgpt", "--json"])
    expect(mock.lookups).toEqual([])
  })

  test("allows a first scoped publish only when the public package is absent", async () => {
    const mock = runner({ role: "admin", access: {}, registryStatus: { "@mongolgpt/sdk": 404 } })
    await expect(
      verifyNpmPublishAccess({ token: "secret", run: mock.run, registryStatus: mock.registryStatus }),
    ).resolves.toMatchObject({ platformPackages: npmPublishPlatformPackages.length })
    expect(mock.lookups).toEqual([...npmPublishPlatformPackages])
  })

  test("rejects an existing or unreadable scoped package without read-write access", async () => {
    for (const status of [200, 401, 429, 503]) {
      const mock = runner({ role: "developer", access: {}, registryStatus: { "@mongolgpt/sdk": status } })
      await expect(
        verifyNpmPublishAccess({ token: "secret", run: mock.run, registryStatus: mock.registryStatus }),
      ).rejects.toThrow(status === 200 ? "publish эрхгүй" : `HTTP ${status}`)
      expect(mock.lookups).toEqual(["@mongolgpt/sdk"])
    }
  })

  test("rejects scoped read-only access before registry lookup", async () => {
    const mock = runner({ role: "developer", access: { "@mongolgpt/sdk": "read-only" } })
    await expect(
      verifyNpmPublishAccess({ token: "secret", run: mock.run, registryStatus: mock.registryStatus }),
    ).rejects.toThrow("read-write эрхгүй")
    expect(mock.lookups).toEqual([])
  })

  test("fails before publication when the npm account is not a scoped organization member", async () => {
    const mock = runner({})
    await expect(
      verifyNpmPublishAccess({ token: "secret", run: mock.run, registryStatus: mock.registryStatus }),
    ).rejects.toThrow(
      "@mongolgpt organization-д publish эрхгүй",
    )
    expect(mock.calls.some((args) => args[0] === "access")).toBe(false)
  })

  test("fails closed when scoped package access cannot be inspected", async () => {
    const mock = runner({ role: "developer", fail: (args) => args[0] === "access" })
    await expect(
      verifyNpmPublishAccess({ token: "secret", run: mock.run, registryStatus: mock.registryStatus }),
    ).rejects.toThrow(
      "@mongolgpt package access шалгалт амжилтгүй",
    )
  })

  test("requires the automation token before contacting npm", async () => {
    const mock = runner({ role: "owner" })
    await expect(
      verifyNpmPublishAccess({ token: " ", run: mock.run, registryStatus: mock.registryStatus }),
    ).rejects.toThrow("NPM_TOKEN")
    expect(mock.calls).toEqual([])
  })
})
