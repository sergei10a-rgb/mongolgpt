import { describe, expect, test } from "bun:test"
import { handleAccountDeletion, type AccountDeletionService } from "./account-deletion-api"

const identity = { accountID: "acc_current", email: "owner@example.com" }

function request(method: string, body?: unknown, origin = "https://app.mgpt.mn") {
  return new Request(`https://app.mgpt.mn/api/account-deletion`, {
    method,
    headers: {
      origin,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

function service(overrides: Partial<AccountDeletionService> = {}): AccountDeletionService {
  return {
    getAccountDeletion: async ({ accountID }) => ({ accountID, status: "none" }),
    requestAccountDeletion: async ({ accountID }) => ({ accountID, status: "scheduled" }),
    cancelAccountDeletion: async ({ accountID }) => ({ accountID, status: "cancelled" }),
    ...overrides,
  }
}

async function body(response: Response) {
  return response.json()
}

describe("account deletion API", () => {
  test("rejects unauthenticated requests", async () => {
    const response = await handleAccountDeletion({ request: request("GET"), service: service() })
    expect(response.status).toBe(401)
    expect(response.headers.get("cache-control")).toBe("no-store")
  })

  test("rejects foreign origins before reading the body", async () => {
    const calls: string[] = []
    const response = await handleAccountDeletion({
      request: request("POST", { email: identity.email, confirmation: "УСТГАХ" }, "https://evil.example"),
      identity,
      service: service({ requestAccountDeletion: async () => calls.push("called") }),
    })
    expect(response.status).toBe(403)
    expect(calls).toEqual([])
  })

  test("uses the session email only to validate confirmation", async () => {
    const response = await handleAccountDeletion({
      request: request("POST", { email: "another@example.com", confirmation: "УСТГАХ" }),
      identity,
      service: service(),
    })
    expect(response.status).toBe(400)
  })

  test("returns an idempotent request result and never accepts an account override", async () => {
    const received: Array<{ accountID: string }> = []
    const response = await handleAccountDeletion({
      request: request("POST", { email: identity.email, confirmation: "УСТГАХ", accountID: "acc_foreign" }),
      identity,
      service: service({
        requestAccountDeletion: async (input) => {
          received.push(input)
          return { status: "scheduled" }
        },
      }),
    })
    expect(response.status).toBe(200)
    expect(await body(response)).toEqual({ success: true, deletion: { status: "scheduled" } })
    expect(received).toEqual([{ accountID: "acc_current" }])
  })

  test("cancels with the session account and rejects malformed JSON", async () => {
    const received: Array<{ accountID: string }> = []
    const response = await handleAccountDeletion({
      request: request("DELETE", { confirmation: "ЦУЦЛАХ", accountID: "acc_foreign" }),
      identity,
      service: service({
        cancelAccountDeletion: async (input) => {
          received.push(input)
          return { status: "cancelled" }
        },
      }),
    })
    expect(response.status).toBe(200)
    expect(await body(response)).toEqual({ success: true, deletion: { status: "cancelled" } })
    expect(received).toEqual([{ accountID: "acc_current" }])

    const malformed = await handleAccountDeletion({
      request: new Request("https://app.mgpt.mn/api/account-deletion", {
        method: "DELETE",
        headers: { origin: "https://app.mgpt.mn", "content-type": "application/json" },
        body: "{",
      }),
      identity,
      service: service(),
    })
    expect(malformed.status).toBe(400)
  })

  test("maps typed core errors to not found and conflict", async () => {
    const notFound = await handleAccountDeletion({
      request: request("GET"),
      identity,
      service: service({
        getAccountDeletion: async () => {
          throw { code: "ACCOUNT_NOT_FOUND" }
        },
      }),
    })
    const conflict = await handleAccountDeletion({
      request: request("POST", { email: identity.email, confirmation: "УСТГАХ" }),
      identity,
      service: service({
        requestAccountDeletion: async () => {
          throw { code: "DELETION_CONFLICT" }
        },
      }),
    })
    const tooLate = await handleAccountDeletion({
      request: request("DELETE", { confirmation: "ЦУЦЛАХ" }),
      identity,
      service: service({
        cancelAccountDeletion: async () => {
          throw { code: "too_late" }
        },
      }),
    })
    expect(notFound.status).toBe(404)
    expect(conflict.status).toBe(409)
    expect(tooLate.status).toBe(409)
  })
})
