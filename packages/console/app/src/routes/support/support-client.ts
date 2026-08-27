export type SupportStatus = "open" | "pending_user" | "pending_support" | "resolved" | "closed"
export type SupportCategory = "account" | "billing" | "technical" | "feedback" | "other"

export type SupportTicket = {
  id: string
  workspace_id?: string | null
  subject: string
  category: SupportCategory
  status: SupportStatus
  lock_version: number
  last_message_at: string
  time_resolved?: string | null
  time_closed?: string | null
  time_created: string
  time_updated: string
}

export type SupportMessage = {
  id: string
  author_type: "customer" | "admin"
  body: string
  time_created: string
}

export type SupportTicketDetail = { ticket: SupportTicket; messages: SupportMessage[] }
export type SupportTicketPage = { items: SupportTicket[]; nextCursor?: string }

type SupportApiError = { message?: string }

export class SupportRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = "SupportRequestError"
  }
}

export async function listTickets(cursor?: string): Promise<SupportTicketPage> {
  const query = new URLSearchParams({ limit: "25" })
  if (cursor) query.set("cursor", cursor)
  return request(`/v1/support/tickets?${query}`)
}

export async function createTicket(input: {
  subject: string
  category: SupportCategory
  workspaceID?: string
  message: string
}) {
  return request<{ id: string; status: SupportStatus; lockVersion: number }>("/v1/support/tickets", {
    method: "POST",
    body: JSON.stringify(input),
  })
}

export async function getTicket(ticketID: string): Promise<SupportTicketDetail> {
  return request(`/v1/support/tickets/${encodeURIComponent(ticketID)}`)
}

export async function replyToTicket(ticketID: string, message: string, expectedLockVersion: number) {
  return request<{ id: string; status: SupportStatus; lockVersion: number }>(
    `/v1/support/tickets/${encodeURIComponent(ticketID)}/messages`,
    {
      method: "POST",
      body: JSON.stringify({ message, expectedLockVersion }),
    },
  )
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  })
  const body = (await response.json().catch(() => ({}))) as T & SupportApiError
  if (!response.ok)
    throw new SupportRequestError(response.status, body.message ?? "Тусламжийн хүсэлт амжилтгүй боллоо.")
  return body
}
