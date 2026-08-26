import { describe, expect, test } from "bun:test"
import { verifyQuotaLedgerHealth } from "../src/quota-health"

describe("quota service health", () => {
  test("performs a non-mutating read against the Durable Object ledger", async () => {
    let request: Request | undefined
    await verifyQuotaLedgerHealth(async (input) => {
      request = input
      return Response.json({ values: { "system/health": 0 } })
    })

    if (!request) throw new Error("Quota health request was not captured")
    expect(request.method).toBe("POST")
    expect(await request.text()).toBe(JSON.stringify({ type: "read", keys: ["system/health"] }))
  })

  test("rejects HTTP success with invalid content type or schema", async () => {
    await expectFailure(
      verifyQuotaLedgerHealth(async () => new Response('{"values":{"system/health":0}}')),
      "хариу",
    )
    await expectFailure(
      verifyQuotaLedgerHealth(async () => Response.json({ values: {} })),
      "утгууд",
    )
    await expectFailure(
      verifyQuotaLedgerHealth(async () => Response.json({ values: { "system/health": -1 } })),
      "тоолуур",
    )
  })
})

async function expectFailure(operation: Promise<void>, message: string) {
  let failure: unknown
  try {
    await operation
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(Error)
  if (!(failure instanceof Error)) throw new Error("Quota health probe should have failed")
  expect(failure.message).toContain(message)
}
