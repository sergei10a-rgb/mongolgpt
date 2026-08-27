import { Title } from "@solidjs/meta"
import { A, createAsync, query, useSearchParams } from "@solidjs/router"
import { For, Show } from "solid-js"
import { AdminHeader } from "~/component/admin-header"
import { listAdminAudit } from "~/lib/admin-audit"
import { getPlatformAdminContext } from "~/lib/admin-context"

export const adminAuditQuery = query(
  async (input: { q?: string; outcome?: string; cursor?: string; limit?: number }) => {
    "use server"
    return listAdminAudit(getPlatformAdminContext(), input)
  },
  "admin.audit.list",
)

export default function AdminAuditPage() {
  const [search] = useSearchParams()
  const audit = createAsync(() =>
    adminAuditQuery({
      q: typeof search.q === "string" ? search.q : "",
      outcome: typeof search.outcome === "string" ? search.outcome : "all",
      cursor: typeof search.cursor === "string" ? search.cursor : undefined,
      limit: search.limit === "50" ? 50 : 25,
    }),
  )

  return (
    <>
      <Title>Админы үйлдлийн бүртгэл | MongolGPT</Title>
      <Show
        when={audit()}
        fallback={
          <main data-page="admin-audit">
            <section data-component="loading" aria-live="polite">
              Админы үйлдлийн бүртгэлийг ачаалж байна...
            </section>
          </main>
        }
      >
        {(data) => (
          <>
            <AdminHeader admin={data().admin} active="audit" />
            <main data-page="admin-audit">
              <section data-component="page-heading">
                <div>
                  <p data-component="eyebrow">Аюулгүй байдал ба хариуцлага</p>
                  <h1>Админы үйлдлийн бүртгэл</h1>
                </div>
                <span data-component="read-only">Өөрчлөх боломжгүй бүртгэл</span>
              </section>

              <form method="get" data-component="audit-filters" aria-label="Админы үйлдлийн бүртгэл шүүх">
                <label>
                  <span>Хайлт</span>
                  <input
                    type="search"
                    name="q"
                    value={data().filters.q}
                    maxlength="100"
                    placeholder="Админ, үйлдэл, зорилт эсвэл хүсэлтийн ID"
                  />
                </label>
                <label>
                  <span>Үр дүн</span>
                  <select name="outcome" value={data().filters.outcome}>
                    <option value="all">Бүх үр дүн</option>
                    <option value="success">Амжилттай</option>
                    <option value="denied">Татгалзсан</option>
                    <option value="failure">Алдаатай</option>
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

              <section data-component="audit-directory" aria-labelledby="audit-directory-title">
                <div data-component="section-heading">
                  <div>
                    <p data-component="eyebrow">Cloudflare Access-аар баталгаажсан үйлдэл</p>
                    <h2 id="audit-directory-title">Бүртгэлүүд</h2>
                  </div>
                  <span>{data().entries.length} үр дүн</span>
                </div>
                <div data-component="table-scroll">
                  <table data-table="audit">
                    <thead>
                      <tr>
                        <th>Үйлдэл</th>
                        <th>Админ</th>
                        <th>Зорилт</th>
                        <th>Үр дүн</th>
                        <th>Хүсэлтийн ID</th>
                        <th>Эх үүсвэр</th>
                        <th>Огноо</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For
                        each={data().entries}
                        fallback={
                          <tr>
                            <td colspan="7" data-empty>
                              Сонгосон нөхцөлд тохирох админы үйлдэл алга.
                            </td>
                          </tr>
                        }
                      >
                        {(entry) => (
                          <tr>
                            <td data-audit-action>
                              <code title={entry.action}>{entry.action}</code>
                            </td>
                            <td>{entry.actor}</td>
                            <td data-audit-target>
                              <span>{entry.targetType || "-"}</span>
                              <code title={entry.targetID ?? undefined}>{entry.targetID || "-"}</code>
                            </td>
                            <td>
                              <span data-outcome={entry.outcome}>{outcomeLabel(entry.outcome)}</span>
                            </td>
                            <td>
                              <code title={entry.requestID}>{entry.requestID}</code>
                            </td>
                            <td>{entry.sourceIP || "-"}</td>
                            <td>{formatDate(entry.time)}</td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
              </section>

              <nav data-component="pagination" aria-label="Админы үйлдлийн бүртгэлийн хуудас">
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

function directoryURL(filters: { q: string; outcome: string; limit: number }, cursor: string | undefined) {
  const search = new URLSearchParams()
  if (filters.q) search.set("q", filters.q)
  if (filters.outcome !== "all") search.set("outcome", filters.outcome)
  if (filters.limit !== 25) search.set("limit", String(filters.limit))
  if (cursor) search.set("cursor", cursor)
  const query = search.toString()
  return query ? `/audit?${query}` : "/audit"
}

function outcomeLabel(outcome: string) {
  return (
    {
      success: "Амжилттай",
      denied: "Татгалзсан",
      failure: "Алдаатай",
    }[outcome] ?? `Тодорхойгүй үр дүн (${outcome})`
  )
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("mn-MN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Ulaanbaatar",
  }).format(new Date(value))
}
