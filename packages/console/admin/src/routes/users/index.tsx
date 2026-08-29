import { Title } from "@solidjs/meta"
import { A, action, createAsync, json, query, useSearchParams, useSubmission } from "@solidjs/router"
import { getRequestEvent } from "solid-js/web"
import { For, Show } from "solid-js"
import { AdminHeader } from "~/component/admin-header"
import { getPlatformAdminContext } from "~/lib/admin-context"
import { changeAdminAccountStatus, listAdminUsers } from "~/lib/admin-users"

export const adminUsersQuery = query(
  async (input: { q?: string; status?: string; cursor?: string; limit?: number }) => {
    "use server"
    return listAdminUsers(getPlatformAdminContext(), input)
  },
  "admin.users.list",
)

export const changeAccountStatusAction = action(async (form: FormData) => {
  "use server"
  const event = getRequestEvent()
  if (!event) throw new Error("Админы хүсэлтийн орчин олдсонгүй.")
  return json(
    await changeAdminAccountStatus(getPlatformAdminContext(), event.request, Object.fromEntries(form.entries())),
    { revalidate: adminUsersQuery.key },
  )
}, "admin.users.status")

export default function AdminUsersPage() {
  const [search] = useSearchParams()
  const users = createAsync(() =>
    adminUsersQuery({
      q: typeof search.q === "string" ? search.q : "",
      status: typeof search.status === "string" ? search.status : "all",
      cursor: typeof search.cursor === "string" ? search.cursor : undefined,
      limit: search.limit === "50" ? 50 : 25,
    }),
  )
  const submission = useSubmission(changeAccountStatusAction)

  return (
    <>
      <Title>Хэрэглэгчийн удирдлага | MongolGPT</Title>
      <Show
        when={users()}
        fallback={
          <main data-page="admin-users">
            <section data-component="loading" aria-live="polite">
              Хэрэглэгчийн мэдээллийг ачаалж байна...
            </section>
          </main>
        }
      >
        {(data) => (
          <>
            <AdminHeader admin={data().admin} active="users" />
            <main data-page="admin-users">
              <section data-component="page-heading">
                <div>
                  <p data-component="eyebrow">Аккаунтын хандалт</p>
                  <h1>Хэрэглэгчийн удирдлага</h1>
                </div>
                <span data-component="read-only">
                  {data().canSuspend ? "Төлөв удирдах эрхтэй" : "Зөвхөн харах горим"}
                </span>
              </section>

              <Show when={submission.result}>
                {(result) => (
                  <p
                    data-component="action-message"
                    data-outcome={result().ok ? "success" : "failure"}
                    role={result().ok ? "status" : "alert"}
                    aria-live="polite"
                  >
                    {result().message}
                  </p>
                )}
              </Show>

              <form method="get" data-component="user-filters" aria-label="Хэрэглэгч шүүх">
                <label>
                  <span>Хайлт</span>
                  <input
                    type="search"
                    name="q"
                    value={data().filters.q}
                    maxlength="100"
                    placeholder="Имэйл эсвэл аккаунтын ID"
                  />
                </label>
                <label>
                  <span>Төлөв</span>
                  <select name="status" value={data().filters.status}>
                    <option value="all">Бүх төлөв</option>
                    <option value="active">Идэвхтэй</option>
                    <option value="suspended">Түдгэлзсэн</option>
                  </select>
                </label>
                <label>
                  <span>Хуудасны хэмжээ</span>
                  <select name="limit" value={String(data().filters.limit)}>
                    <option value="25">25</option>
                    <option value="50">50</option>
                  </select>
                </label>
                <button type="submit">Хайх</button>
              </form>

              <section data-component="user-directory" aria-labelledby="user-directory-title">
                <div data-component="section-heading">
                  <div>
                    <p data-component="eyebrow">Нэгдсэн Web, Desktop, CLI эрх</p>
                    <h2 id="user-directory-title">Аккаунтууд</h2>
                  </div>
                  <span>{data().accounts.length} үр дүн</span>
                </div>
                <div data-component="table-scroll">
                  <table data-table="users">
                    <thead>
                      <tr>
                        <th>Аккаунт</th>
                        <th>Төлөв</th>
                        <th>Орон зай</th>
                        <th>Гишүүнчлэл</th>
                        <th>Сүүлд ашигласан</th>
                        <th>Үүссэн</th>
                        <th>Харалт</th>
                        <Show when={data().canSuspend}>
                          <th>Үйлдэл</th>
                        </Show>
                      </tr>
                    </thead>
                    <tbody>
                      <For
                        each={data().accounts}
                        fallback={
                          <tr>
                            <td colspan={data().canSuspend ? 8 : 7} data-empty>
                              Сонгосон нөхцөлд тохирох аккаунт алга.
                            </td>
                          </tr>
                        }
                      >
                        {(account) => {
                          const ownAccount = account.email?.trim().toLowerCase() === data().admin.email
                          const operation = account.status === "active" ? "suspend" : "reactivate"
                          return (
                            <tr data-status={account.status}>
                              <td data-account>
                                <strong>{account.email || "Баталгаажсан имэйл алга"}</strong>
                                <code>{account.id}</code>
                                <Show when={account.reason}>
                                  <small title={account.reason ?? undefined}>{account.reason}</small>
                                </Show>
                              </td>
                              <td>
                                <span data-account-status={account.status}>{statusLabel(account.status)}</span>
                              </td>
                              <td>{formatNumber(account.workspaces)}</td>
                              <td>{formatNumber(account.memberships)}</td>
                              <td>{formatDate(account.lastSeen)}</td>
                              <td>{formatDate(account.timeCreated)}</td>
                              <td data-action-cell>
                                <Show when={data().canInspectBilling}>
                                  <A href={`/users/${account.id}`}>Дэлгэрэнгүй</A>
                                </Show>
                              </td>
                              <Show when={data().canSuspend}>
                                <td data-action-cell>
                                  <Show
                                    when={!ownAccount || operation === "reactivate"}
                                    fallback={<span data-component="self-account">Өөрийн аккаунт</span>}
                                  >
                                    <details data-component="account-action">
                                      <summary>{operation === "suspend" ? "Түдгэлзүүлэх" : "Идэвхжүүлэх"}</summary>
                                      <form action={changeAccountStatusAction} method="post">
                                        <input type="hidden" name="accountID" value={account.id} />
                                        <input type="hidden" name="operation" value={operation} />
                                        <label for={`reason-${account.id}`}>Шалтгаан</label>
                                        <textarea
                                          id={`reason-${account.id}`}
                                          name="reason"
                                          required
                                          minlength="10"
                                          maxlength="500"
                                          rows="3"
                                          placeholder={
                                            operation === "suspend"
                                              ? "Яагаад түр түдгэлзүүлж байгааг тодорхой бичнэ үү"
                                              : "Яагаад дахин идэвхжүүлж байгааг бичнэ үү"
                                          }
                                        />
                                        <button type="submit" disabled={submission.pending}>
                                          {submission.pending
                                            ? "Хадгалж байна..."
                                            : operation === "suspend"
                                              ? "Түдгэлзүүлэх"
                                              : "Идэвхжүүлэх"}
                                        </button>
                                      </form>
                                    </details>
                                  </Show>
                                </td>
                              </Show>
                            </tr>
                          )
                        }}
                      </For>
                    </tbody>
                  </table>
                </div>
              </section>

              <nav data-component="pagination" aria-label="Хэрэглэгчийн жагсаалтын хуудас">
                <Show when={data().filters.cursor}>
                  <A href={directoryURL(data().filters, undefined)}>Эхний хуудас</A>
                </Show>
                <Show when={data().nextCursor}>
                  {(cursor) => <A href={directoryURL(data().filters, cursor())}>Дараах хуудас</A>}
                </Show>
              </nav>
            </main>
          </>
        )}
      </Show>
    </>
  )
}

function directoryURL(filters: { q: string; status: string; limit: number }, cursor: string | undefined) {
  const search = new URLSearchParams()
  if (filters.q) search.set("q", filters.q)
  if (filters.status !== "all") search.set("status", filters.status)
  if (filters.limit !== 25) search.set("limit", String(filters.limit))
  if (cursor) search.set("cursor", cursor)
  const query = search.toString()
  return query ? `/users?${query}` : "/users"
}

function statusLabel(status: string) {
  return status === "suspended" ? "Түдгэлзсэн" : "Идэвхтэй"
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("mn-MN").format(value)
}

function formatDate(value: string | null) {
  if (!value) return "-"
  return new Intl.DateTimeFormat("mn-MN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Ulaanbaatar",
  }).format(new Date(value))
}
