import { expect, test } from "bun:test"
import { AccountDeletionError } from "@mongolgpt/console-core/account-deletion.js"
import { handleSupportAccountDeletion } from "../src/lib/support-account-deletion"

const secret = "fixture-support-secret"
function request(input: { auth?: string; method?: string; type?: string; body?: string } = {}) {
  return new Request("https://console.example.invalid/api/support/actions/delete-account", {
    method: input.method ?? "DELETE",
    headers: { authorization: input.auth ?? `Bearer ${secret}`, "content-type": input.type ?? "application/json" },
    body: input.body ?? JSON.stringify({ email: "fixture@example.invalid" }),
  })
}

test("support queues the normal deletion flow without reporting completed erasure", async () => {
  const calls: string[] = []
  const deletion = { id: "del_fixture", status: "requested", eligibleAt: 2_000_000_000_000 }
  const response = await handleSupportAccountDeletion(request(), {
    secret,
    requestDeletion: async (email) => {
      calls.push(email)
      return deletion
    },
  })
  expect(response.status).toBe(202)
  expect(response.headers.get("content-type")).toStartWith("application/json")
  expect(response.headers.get("cache-control")).toBe("no-store")
  expect(await response.json()).toEqual({ success: true, deletion, message: "Бүртгэл устгах хүсэлт бүртгэгдлээ" })
  expect(calls).toEqual(["fixture@example.invalid"])
})

test("support rejects missing credentials, malformed requests and methods before touching an account", async () => {
  let calls = 0
  const service = {
    secret,
    requestDeletion: async () => {
      calls++
      return null
    },
  }
  for (const [input, status] of [
    [{ auth: "" }, 401],
    [{ auth: "Bearer wrong" }, 401],
    [{ method: "POST" }, 405],
    [{ body: "{" }, 400],
    [{ type: "text/plain" }, 400],
    [{ body: '{"email":"invalid"}' }, 400],
  ] as const) {
    const response = await handleSupportAccountDeletion(request(input), service)
    expect(response.status).toBe(status)
    expect(response.headers.get("cache-control")).toBe("no-store")
  }
  expect((await handleSupportAccountDeletion(request({ auth: "Bearer " }), { ...service, secret: "" })).status).toBe(
    401,
  )
  expect(calls).toBe(0)
})

test("support preserves conflicts and sanitizes database and external failures", async () => {
  for (const [error, status] of [
    [new AccountDeletionError("not_found"), 404],
    [new AccountDeletionError("workspace_admin_required"), 409],
    [new AccountDeletionError("too_late"), 409],
    [new Error("private SQL, email and credentials"), 503],
  ] as const) {
    const response = await handleSupportAccountDeletion(request(), {
      secret,
      requestDeletion: async () => {
        throw error
      },
    })
    expect(response.status).toBe(status)
    expect(await response.json()).toEqual({ error: "Бүртгэл устгах хүсэлтийг хүлээн авч чадсангүй." })
  }
})
