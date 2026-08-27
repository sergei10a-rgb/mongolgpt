import { describe, expect, test } from "bun:test"
import { SupportError } from "@mongolgpt/console-core/support.js"
import {
  type HandlerInput,
  type SupportService,
  createTicketRequest,
  listTicketsRequest,
  replyTicketRequest,
  supportPreflight,
  ticketDetailRequest,
} from "./support-handler"

const appUrl = "https://app.dev.mgpt.mn"
const ticketID = "spt_01J5E0H8K3G6V3DBJYF18TKWYR"
const account = { id: "acc_support_user", email: "user@mgpt.mn" }
const other = { id: "acc_other_user", email: "other@mgpt.mn" }

function request(path: string, init: RequestInit & { origin?: string } = {}) {
  const headers = new Headers(init.headers)
  if (init.origin !== "") headers.set("origin", init.origin ?? appUrl)
  return new Request(`https://dev.mgpt.mn${path}`, { ...init, headers })
}

function handler(
  identity: Awaited<ReturnType<HandlerInput["authenticate"]>> = { status: "authenticated", account },
  overrides: Partial<SupportService> = {},
) {
  const calls: Record<string, unknown[]> = { create: [], list: [], detail: [], reply: [] }
  const service: SupportService = {
    create: async (input) => {
      calls.create.push(input)
      return { id: ticketID, status: "open" as const, lockVersion: 0 }
    },
    list: async (input) => {
      calls.list.push(input)
      return { items: [{ id: ticketID }], nextCursor: undefined }
    },
    detail: async (input) => {
      calls.detail.push(input)
      return { ticket: { id: ticketID }, messages: [] }
    },
    reply: async (input) => {
      calls.reply.push(input)
      return { id: ticketID, status: "pending_support" as const, lockVersion: 1 }
    },
    ...overrides,
  }
  return {
    calls,
    input: {
      appUrl,
      authenticate: async () => identity,
      service,
    },
  }
}

const ticketBody = { subject: "Төлбөрийн асуулт", category: "billing", message: "Туслаарай" }

describe("customer support HTTP routes", () => {
  test("creates, lists, reads, and replies only as the verified bearer or session account", async () => {
    const { calls, input } = handler()
    const created = await createTicketRequest(
      request("/v1/support/tickets", {
        method: "POST",
        headers: { authorization: "Bearer verified", "content-type": "application/json" },
        origin: "",
        body: JSON.stringify({ ...ticketBody, accountID: other.id }),
      }),
      input,
    )
    expect(created.status).toBe(400)
    expect(calls.create).toEqual([])

    const validCreate = await createTicketRequest(
      request("/v1/support/tickets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...ticketBody, workspaceID: "wrk_support_user" }),
      }),
      input,
    )
    expect(validCreate.status).toBe(201)
    expect(calls.create).toEqual([
      {
        accountID: account.id,
        requesterEmail: account.email,
        workspaceID: "wrk_support_user",
        ...ticketBody,
      },
    ])

    expect((await listTicketsRequest(request("/v1/support/tickets?limit=50"), input)).status).toBe(200)
    expect(calls.list).toEqual([{ accountID: account.id, cursor: undefined, limit: 50 }])
    expect((await ticketDetailRequest(request(`/v1/support/tickets/${ticketID}`), ticketID, input)).status).toBe(200)
    expect(calls.detail).toEqual([{ accountID: account.id, ticketID }])

    const replied = await replyTicketRequest(
      request(`/v1/support/tickets/${ticketID}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Нэмэлт мэдээлэл", expectedLockVersion: 0 }),
      }),
      ticketID,
      input,
    )
    expect(replied.status).toBe(200)
    expect(calls.reply).toEqual([
      { accountID: account.id, ticketID, message: "Нэмэлт мэдээлэл", expectedLockVersion: 0 },
    ])
  })

  test("handles anonymous, suspended, foreign-origin, and session CSRF requests", async () => {
    const anonymous = handler({ status: "unauthorized" as const })
    expect((await listTicketsRequest(request("/v1/support/tickets"), anonymous.input)).status).toBe(401)
    const suspended = handler({ status: "suspended" as const })
    expect(
      (await createTicketRequest(request("/v1/support/tickets", { method: "POST" }), suspended.input)).status,
    ).toBe(403)

    const active = handler()
    expect(
      (
        await createTicketRequest(
          request("/v1/support/tickets", {
            method: "POST",
            origin: "https://attacker.example",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(ticketBody),
          }),
          active.input,
        )
      ).status,
    ).toBe(403)
    expect(active.calls.create).toEqual([])
    expect(
      (
        await createTicketRequest(
          request("/v1/support/tickets", {
            method: "POST",
            origin: "",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(ticketBody),
          }),
          active.input,
        )
      ).status,
    ).toBe(403)
    expect(
      (
        await createTicketRequest(
          request("/v1/support/tickets", {
            method: "POST",
            origin: "",
            headers: { authorization: "", "content-type": "application/json" },
            body: JSON.stringify(ticketBody),
          }),
          active.input,
        )
      ).status,
    ).toBe(403)
    expect(
      (
        await createTicketRequest(
          request("/v1/support/tickets", {
            method: "POST",
            origin: "",
            headers: { authorization: "Bearer verified", "content-type": "application/json" },
            body: JSON.stringify(ticketBody),
          }),
          active.input,
        )
      ).status,
    ).toBe(201)
  })

  test("enforces exact CORS preflight, JSON type, body bounds, and strict public input", async () => {
    expect(supportPreflight(request("/v1/support/tickets", { method: "OPTIONS" }), appUrl).status).toBe(204)
    expect(
      supportPreflight(
        request("/v1/support/tickets", { method: "OPTIONS", origin: "https://attacker.example" }),
        appUrl,
      ).status,
    ).toBe(403)
    const { input } = handler()
    expect(
      (
        await createTicketRequest(
          request("/v1/support/tickets", { method: "POST", body: JSON.stringify(ticketBody) }),
          input,
        )
      ).status,
    ).toBe(400)
    expect(
      (
        await createTicketRequest(
          request("/v1/support/tickets", {
            method: "POST",
            headers: { "content-type": "application/json", "content-length": "16385" },
            body: JSON.stringify(ticketBody),
          }),
          input,
        )
      ).status,
    ).toBe(400)
    expect(
      (
        await createTicketRequest(
          request("/v1/support/tickets", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...ticketBody, unexpected: true }),
          }),
          input,
        )
      ).status,
    ).toBe(400)
    expect((await listTicketsRequest(request("/v1/support/tickets?accountID=acc_other"), input)).status).toBe(400)
    expect((await ticketDetailRequest(request("/v1/support/tickets/not-a-ticket"), "not-a-ticket", input)).status).toBe(
      400,
    )
  })

  test("returns not-found for another account ticket and maps core failures without exposing details", async () => {
    const { input } = handler(
      { status: "authenticated", account },
      {
        detail: async () => {
          throw new SupportError("not_found", "account acc_other_user exists")
        },
        reply: async () => {
          throw new SupportError("closed", "private support state")
        },
        create: async () => {
          throw new SupportError("rate_limit", "internal quota data")
        },
      },
    )
    const detail = await ticketDetailRequest(request(`/v1/support/tickets/${ticketID}`), ticketID, input)
    expect(detail.status).toBe(404)
    expect(JSON.stringify(await detail.json())).not.toContain("acc_other")
    const reply = await replyTicketRequest(
      request(`/v1/support/tickets/${ticketID}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "хариу", expectedLockVersion: 0 }),
      }),
      ticketID,
      input,
    )
    expect(reply.status).toBe(409)
    const create = await createTicketRequest(
      request("/v1/support/tickets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(ticketBody),
      }),
      input,
    )
    expect(create.status).toBe(429)
  })
})
