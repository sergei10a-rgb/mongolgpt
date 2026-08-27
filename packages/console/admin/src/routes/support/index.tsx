import { Title } from "@solidjs/meta"
import { A, action, createAsync, json, query, useSearchParams, useSubmission } from "@solidjs/router"
import { getRequestEvent } from "solid-js/web"
import { ErrorBoundary, For, Show } from "solid-js"
import { AdminHeader } from "~/component/admin-header"
import { getPlatformAdminContext } from "~/lib/admin-context"
import { listAdminSupportQueue, mutateAdminSupport } from "~/lib/admin-support"

export const adminSupportQueryKey = "admin.support"

export const adminSupportQueueQuery = query(
  async (input: {
    status?: string
    priority?: string
    assignment?: string
    accountID?: string
    cursor?: string
    limit?: number
  }) => {
    "use server"
    return listAdminSupportQueue(getPlatformAdminContext(), {
      status: isStatus(input.status) ? input.status : undefined,
      priority: isPriority(input.priority) ? input.priority : undefined,
      assignment: isAssignment(input.assignment) ? input.assignment : undefined,
      accountID: input.accountID?.trim() || undefined,
      cursor: input.cursor,
      limit: input.limit === 50 ? 50 : 25,
    })
  },
  adminSupportQueryKey,
)

export const mutateAdminSupportAction = action(async (form: FormData) => {
  "use server"
  const event = getRequestEvent()
  if (!event) throw new Error("Админы хүсэлтийн орчин олдсонгүй.")
  const values = Object.fromEntries(form.entries())
  const input =
    values.operation === "update" && values.assignedAdminID === "__unassigned"
      ? { ...values, assignedAdminID: null }
      : values
  return json(await mutateAdminSupport(getPlatformAdminContext(), event.request, input), {
    revalidate: adminSupportQueryKey,
  })
}, "admin.support.mutate")

export default function AdminSupportPage() {
  const [search] = useSearchParams()
  const support = createAsync(() =>
    adminSupportQueueQuery({
      status: typeof search.status === "string" ? search.status : "all",
      priority: typeof search.priority === "string" ? search.priority : "all",
      assignment: typeof search.assignment === "string" ? search.assignment : "all",
      accountID: typeof search.accountID === "string" ? search.accountID : "",
      cursor: typeof search.cursor === "string" ? search.cursor : undefined,
      limit: search.limit === "50" ? 50 : 25,
    }),
  )
  return (
    <>
      <Title>Тусламжийн хүсэлт | MongolGPT</Title>
      <ErrorBoundary fallback={<SupportError />}>
        <Show when={support()} fallback={<Loading />}>
          {(data) => (
            <>
              <AdminHeader admin={data().admin} active="support" />
              <main data-page="admin-support">
                <section data-component="page-heading">
                  <div>
                    <h1>Тусламжийн хүсэлт</h1>
                  </div>
                  <span data-component="read-only">
                    {data().canManage ? "Хариу, тэмдэглэл, төлөв удирдах эрхтэй" : "Зөвхөн харах горим"}
                  </span>
                </section>

                <form method="get" data-component="support-filters" aria-label="Тусламжийн хүсэлт шүүх">
                  <label>
                    <span>Төлөв</span>
                    <select name="status" value={data().filters.status ?? "all"}>
                      <StatusOptions all />
                    </select>
                  </label>
                  <label>
                    <span>Тэргүүлэх зэрэг</span>
                    <select name="priority" value={data().filters.priority ?? "all"}>
                      <PriorityOptions all />
                    </select>
                  </label>
                  <label>
                    <span>Хариуцалт</span>
                    <select name="assignment" value={data().filters.assignment ?? "all"}>
                      <AssignmentOptions all />
                    </select>
                  </label>
                  <label>
                    <span>Аккаунтын ID</span>
                    <input
                      name="accountID"
                      value={data().filters.accountID ?? ""}
                      maxlength="30"
                      placeholder="acc_..."
                    />
                  </label>
                  <label>
                    <span>Хуудасны хэмжээ</span>
                    <select name="limit" value={String(data().filters.limit)}>
                      <option value="25">25</option>
                      <option value="50">50</option>
                    </select>
                  </label>
                  <button type="submit">Шүүх</button>
                </form>

                <section data-component="support-directory" aria-labelledby="support-directory-title">
                  <div data-component="section-heading">
                    <div>
                      <h2 id="support-directory-title">Хүсэлтүүд</h2>
                    </div>
                    <span>{data().items.length} үр дүн</span>
                  </div>
                  <div data-component="table-scroll">
                    <table data-table="support">
                      <thead>
                        <tr>
                          <th>Хүсэлт</th>
                          <th>Аккаунт</th>
                          <th>Ангилал</th>
                          <th>Төлөв</th>
                          <th>Зэрэг</th>
                          <th>Хариуцсан</th>
                          <th>Сүүлд идэвхтэй</th>
                        </tr>
                      </thead>
                      <tbody>
                        <For
                          each={data().items}
                          fallback={
                            <tr>
                              <td colspan="7" data-empty>
                                Сонгосон нөхцөлд тохирох тусламжийн хүсэлт алга.
                              </td>
                            </tr>
                          }
                        >
                          {(ticket) => (
                            <tr>
                              <td data-support-subject>
                                <A href={detailURL(ticket.id)}>{ticket.subject}</A>
                                <code>{ticket.id}</code>
                              </td>
                              <td>
                                <code>{ticket.account_id}</code>
                              </td>
                              <td>{categoryLabel(ticket.category)}</td>
                              <td>
                                <span data-support-status={ticket.status}>{statusLabel(ticket.status)}</span>
                              </td>
                              <td>
                                <span data-support-priority={ticket.priority}>{priorityLabel(ticket.priority)}</span>
                              </td>
                              <td>
                                {ticket.assigned_admin_id ? <code>{ticket.assigned_admin_id}</code> : "Оноогоогүй"}
                              </td>
                              <td>{formatDate(ticket.last_message_at)}</td>
                            </tr>
                          )}
                        </For>
                      </tbody>
                    </table>
                  </div>
                </section>
                <nav data-component="pagination" aria-label="Тусламжийн хүсэлтийн хуудас">
                  <Show when={data().filters.cursor}>
                    <A href={queueURL(data().filters, undefined)}>Эхний хуудас</A>
                  </Show>
                  <Show when={data().nextCursor}>
                    {(cursor) => <A href={queueURL(data().filters, cursor())}>Дараах хуудас</A>}
                  </Show>
                </nav>
              </main>
            </>
          )}
        </Show>
      </ErrorBoundary>
    </>
  )
}

export function Loading() {
  return (
    <main data-page="admin-support">
      <section data-component="loading" aria-live="polite">
        Тусламжийн хүсэлтүүдийг ачаалж байна...
      </section>
    </main>
  )
}
function SupportError() {
  return (
    <main data-page="admin-support">
      <section data-component="empty" role="alert">
        Тусламжийн хүсэлтийг ачаалж чадсангүй. Хуудсыг дахин ачаална уу.
      </section>
    </main>
  )
}
export function StatusOptions(props: { all?: boolean; current?: string }) {
  const statuses = () => {
    const all = ["open", "pending_support", "pending_user", "resolved", "closed"]
    if (!props.current) return all
    if (props.current === "open") return all.slice(0, 4)
    if (props.current === "pending_support") return ["pending_support", "pending_user", "resolved"]
    if (props.current === "pending_user") return ["pending_user", "pending_support", "resolved"]
    if (props.current === "resolved") return ["resolved", "closed"]
    return ["closed"]
  }
  return (
    <>
      {props.all && <option value="all">Бүх төлөв</option>}
      <For each={statuses()}>{(status) => <option value={status}>{statusLabel(status)}</option>}</For>
    </>
  )
}
export function PriorityOptions(props: { all?: boolean }) {
  return (
    <>
      {props.all && <option value="all">Бүх зэрэг</option>}
      <option value="normal">Ердийн</option>
      <option value="high">Өндөр</option>
      <option value="urgent">Яаралтай</option>
    </>
  )
}
export function AssignmentOptions(props: { all?: boolean }) {
  return (
    <>
      {props.all && <option value="all">Бүгд</option>}
      <option value="assigned">Оноосон</option>
      <option value="unassigned">Оноогоогүй</option>
      <option value="mine">Надад оноосон</option>
    </>
  )
}
export function statusLabel(status: string) {
  return (
    {
      open: "Шинэ",
      pending_support: "Админы хариу хүлээж байна",
      pending_user: "Хэрэглэгчийн хариу хүлээж байна",
      resolved: "Шийдсэн",
      closed: "Хаасан",
    }[status] ?? "Тодорхойгүй төлөв"
  )
}
export function priorityLabel(priority: string) {
  return { normal: "Ердийн", high: "Өндөр", urgent: "Яаралтай" }[priority] ?? "Тодорхойгүй зэрэг"
}
export function categoryLabel(category: string) {
  return (
    { account: "Аккаунт", billing: "Төлбөр", technical: "Техникийн асуудал", feedback: "Санал хүсэлт", other: "Бусад" }[
      category
    ] ?? "Бусад"
  )
}
export function formatDate(value: Date | string | null) {
  if (!value) return "-"
  return new Intl.DateTimeFormat("mn-MN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Ulaanbaatar",
  }).format(new Date(value))
}
export function detailURL(ticketID: string) {
  return `/support/${ticketID}`
}
export function queueURL(
  filters: { status?: string; priority?: string; assignment?: string; accountID?: string; limit: number },
  cursor: string | undefined,
) {
  const search = new URLSearchParams()
  if (filters.status) search.set("status", filters.status)
  if (filters.priority) search.set("priority", filters.priority)
  if (filters.assignment) search.set("assignment", filters.assignment)
  if (filters.accountID) search.set("accountID", filters.accountID)
  if (filters.limit !== 25) search.set("limit", String(filters.limit))
  if (cursor) search.set("cursor", cursor)
  const query = search.toString()
  return query ? `/support?${query}` : "/support"
}
function isStatus(
  value: string | undefined,
): value is "open" | "pending_user" | "pending_support" | "resolved" | "closed" {
  return (
    value === "open" ||
    value === "pending_user" ||
    value === "pending_support" ||
    value === "resolved" ||
    value === "closed"
  )
}
function isPriority(value: string | undefined): value is "normal" | "high" | "urgent" {
  return value === "normal" || value === "high" || value === "urgent"
}
function isAssignment(value: string | undefined): value is "assigned" | "unassigned" | "mine" {
  return value === "assigned" || value === "unassigned" || value === "mine"
}
