import { describe, expect, test } from "bun:test"
import { readAdminPlanQuotaWithResources } from "../src/lib/admin-quota.server"

describe("admin quota service client", () => {
  test("prefixes the stage, authenticates the internal request, and validates counters", async () => {
    let captured: { input: string | URL | Request; init?: RequestInit } | undefined
    const result = await readAdminPlanQuotaWithResources(
      { scope: "plan:wrk_test:inv_test", keys: ["user/usr_test/weekly-cost"] },
      {
        stage: "dev",
        token: "test-token",
        fetcher: async (input, init) => {
          captured = { input, init }
          return Response.json({ values: { "user/usr_test/weekly-cost": 42 } })
        },
      },
    )

    expect(result).toEqual({ "user/usr_test/weekly-cost": 42 })
    expect(captured?.input).toBe("https://quota.internal/v1/ledger")
    expect(captured?.init?.method).toBe("POST")
    expect(new Headers(captured?.init?.headers).get("authorization")).toBe("Bearer test-token")
    expect(JSON.parse(String(captured?.init?.body))).toEqual({
      scope: "dev:plan:wrk_test:inv_test",
      command: { type: "read", keys: ["user/usr_test/weekly-cost"] },
    })
  })

  test("fails closed on an invalid or unsuccessful quota response", async () => {
    const input = { scope: "plan:wrk_test:inv_test", keys: ["user/usr_test/weekly-cost"] }
    await expect(
      readAdminPlanQuotaWithResources(input, {
        stage: "dev",
        token: "test-token",
        fetcher: async () => Response.json({ values: { broken: -1 } }),
      }),
    ).rejects.toThrow()
    await expect(
      readAdminPlanQuotaWithResources(input, {
        stage: "dev",
        token: "test-token",
        fetcher: async () => Response.json({ error: "denied" }, { status: 403 }),
      }),
    ).rejects.toThrow("Админ квотын хүсэлт амжилтгүй боллоо.")
  })
})
