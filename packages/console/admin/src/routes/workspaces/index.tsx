import { Title } from "@solidjs/meta"
import { A, createAsync, query, useSearchParams } from "@solidjs/router"
import { For, Show } from "solid-js"
import { AdminHeader } from "~/component/admin-header"
import { getPlatformAdminContext } from "~/lib/admin-context"
import { listAdminWorkspaces } from "~/lib/admin-workspaces"

export const adminWorkspacesQuery = query(
  async (input: { q?: string; cursor?: string; limit?: number; workspace?: string }) => {
    "use server"
    return listAdminWorkspaces(getPlatformAdminContext(), input)
  },
  "admin.workspaces.list",
)

export default function AdminWorkspacesPage() {
  const [search] = useSearchParams()
  const workspaces = createAsync(() =>
    adminWorkspacesQuery({
      q: typeof search.q === "string" ? search.q : "",
      cursor: typeof search.cursor === "string" ? search.cursor : undefined,
      limit: search.limit === "50" ? 50 : 25,
      workspace: typeof search.workspace === "string" ? search.workspace : undefined,
    }),
  )

  return (
    <>
      <Title>Ажлын орон зайн шалгалт | MongolGPT</Title>
      <Show
        when={workspaces()}
        fallback={
          <main data-page="admin-workspaces">
            <section data-component="loading" aria-live="polite">
              Ажлын орон зайн мэдээллийг ачаалж байна...
            </section>
          </main>
        }
      >
        {(data) => (
          <>
            <AdminHeader admin={data().admin} active="workspaces" />
            <main data-page="admin-workspaces">
              <section data-component="page-heading">
                <div>
                  <p data-component="eyebrow">Зөвхөн харах дотоод шалгалт</p>
                  <h1>Ажлын орон зайн шалгалт</h1>
                </div>
                <span data-component="read-only">Хэрэглэгч ба санхүүгийн нэгдсэн харалт</span>
              </section>

              <form method="get" data-component="workspace-filters" aria-label="Ажлын орон зай шүүх">
                <label>
                  <span>Хайлт</span>
                  <input
                    type="search"
                    name="q"
                    value={data().filters.q}
                    maxlength="100"
                    placeholder="Орон зайн ID, нэр эсвэл богино нэр"
                  />
                </label>
                <label>
                  <span>Хуудасны хэмжээ</span>
                  <select name="limit" value={String(data().filters.limit)}>
                    <option value="25">25</option>
                    <option value="50">50</option>
                  </select>
                </label>
                <Show when={data().filters.workspace}>
                  {(workspace) => <input type="hidden" name="workspace" value={workspace()} />}
                </Show>
                <button type="submit">Хайх</button>
              </form>

              <section data-component="workspace-directory" aria-labelledby="workspace-directory-title">
                <div data-component="section-heading">
                  <div>
                    <p data-component="eyebrow">ID эсвэл нэрээр хязгаартай хайлт</p>
                    <h2 id="workspace-directory-title">Ажлын орон зайн жагсаалт</h2>
                  </div>
                  <span>{data().workspaces.length} үр дүн</span>
                </div>
                <div data-component="table-scroll">
                  <table data-table="workspaces">
                    <thead>
                      <tr>
                        <th>Орон зай</th>
                        <th>Гишүүн</th>
                        <th>Аккаунт</th>
                        <th>Сүүлийн ашиглалт</th>
                        <th>Үйлдэл</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For
                        each={data().workspaces}
                        fallback={
                          <tr>
                            <td colspan="5" data-empty>
                              Сонгосон нөхцөлд тохирох ажлын орон зай алга.
                            </td>
                          </tr>
                        }
                      >
                        {(workspace) => (
                          <tr data-selected={data().selectedWorkspace?.id === workspace.id ? "true" : undefined}>
                            <td data-workspace>
                              <strong>{workspace.name}</strong>
                              <code>{workspace.id}</code>
                              <Show when={workspace.slug}>{(slug) => <small>{slug()}</small>}</Show>
                            </td>
                            <td>{formatNumber(workspace.members)}</td>
                            <td>{formatNumber(workspace.accounts)}</td>
                            <td>{formatDate(workspace.lastSeen)}</td>
                            <td data-action-cell>
                              <A href={directoryURL(data().filters, data().filters.cursor, workspace.id)}>
                                Дэлгэрэнгүй
                              </A>
                            </td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
              </section>

              <nav data-component="pagination" aria-label="Ажлын орон зайн жагсаалтын хуудас">
                <Show when={data().filters.cursor}>
                  <A href={directoryURL(data().filters, undefined, data().filters.workspace)}>Эхний хуудас</A>
                </Show>
                <Show when={data().nextCursor}>
                  {(cursor) => (
                    <A href={directoryURL(data().filters, cursor(), data().filters.workspace)}>Дараах хуудас</A>
                  )}
                </Show>
              </nav>

              <section data-component="workspace-detail" aria-labelledby="workspace-detail-title">
                <div data-component="section-heading">
                  <div>
                    <p data-component="eyebrow">Орон зай, аккаунт, хэрэглээ, нэхэмжлэхийн мэдээлэл</p>
                    <h2 id="workspace-detail-title">Сонгосон ажлын орон зай</h2>
                  </div>
                  <span>Шинэчилсэн: {formatDate(data().generatedAt)}</span>
                </div>

                <Show
                  when={data().selectedWorkspace}
                  fallback={<p data-component="empty">Жагсаалтаас нэг ажлын орон зай сонгож дэлгэрэнгүйг харна уу.</p>}
                >
                  {(selectedWorkspace) => {
                    const workspace = selectedWorkspace()
                    return (
                      <>
                        <section data-component="status-band">
                          <div>
                            <span>Ажлын орон зай</span>
                            <strong>{workspace.name}</strong>
                            <code>{workspace.id}</code>
                          </div>
                          <div>
                            <span>Богино нэр</span>
                            <strong>{workspace.slug || "Тохируулаагүй"}</strong>
                          </div>
                          <div>
                            <span>Идэвхтэй гишүүн / бүртгэл</span>
                            <strong>
                              {formatNumber(workspace.members.total)} / {formatNumber(workspace.members.accounts)}
                            </strong>
                          </div>
                          <div>
                            <span>Сүүлд ашигласан</span>
                            <strong>{formatDate(workspace.members.lastSeen)}</strong>
                          </div>
                        </section>

                        <section data-component="data-section" aria-labelledby="workspace-members-title">
                          <div data-component="section-heading">
                            <div>
                              <p data-component="eyebrow">Одоогийн гишүүнчлэлийн мэдээлэл</p>
                              <h2 id="workspace-members-title">Идэвхтэй гишүүд ба аккаунтууд</h2>
                            </div>
                            <span>
                              Нийт {formatNumber(workspace.members.total)} ·{" "}
                              {formatNumber(workspace.members.entries.length)}-г харуулав
                            </span>
                          </div>
                          <div data-component="table-scroll">
                            <table data-table="workspace-members">
                              <thead>
                                <tr>
                                  <th>Гишүүн</th>
                                  <th>Эрх</th>
                                  <th>Аккаунт</th>
                                  <th>Төлөв</th>
                                  <th>Сүүлд ашигласан</th>
                                </tr>
                              </thead>
                              <tbody>
                                <For
                                  each={workspace.members.entries}
                                  fallback={
                                    <tr>
                                      <td colspan="5" data-empty>
                                        Идэвхтэй гишүүн бүртгэл алга.
                                      </td>
                                    </tr>
                                  }
                                >
                                  {(member) => (
                                    <tr>
                                      <td data-account>
                                        <strong>{member.name}</strong>
                                        <Show when={member.email}>{(email) => <small>{email()}</small>}</Show>
                                        <Show when={member.id}>{(id) => <code>{id()}</code>}</Show>
                                      </td>
                                      <td>{member.role === "admin" ? "Админ" : "Гишүүн"}</td>
                                      <td>
                                        {member.accountID ? <code>{member.accountID}</code> : "Урилгаар хүлээж буй"}
                                      </td>
                                      <td>
                                        <Show
                                          when={member.accountID}
                                          fallback={<span data-account-status="pending">Холбогдоогүй</span>}
                                        >
                                          <span data-account-status={member.accountStatus ?? "active"}>
                                            {member.accountStatus === "suspended" ? "Түдгэлзсэн" : "Идэвхтэй"}
                                          </span>
                                        </Show>
                                      </td>
                                      <td>{formatDate(member.timeSeen)}</td>
                                    </tr>
                                  )}
                                </For>
                              </tbody>
                            </table>
                          </div>
                        </section>

                        <section data-component="data-section" aria-labelledby="workspace-subscription-title">
                          <div data-component="section-heading">
                            <div>
                              <p data-component="eyebrow">Одоогийн багцын төлөв</p>
                              <h2 id="workspace-subscription-title">Багц ба нэхэмжлэхийн төлөв</h2>
                            </div>
                          </div>
                          <Show
                            when={workspace.subscription}
                            fallback={<p data-component="empty">Энэ ажлын орон зайд багцын бүртгэл олдсонгүй.</p>}
                          >
                            {(subscription) => (
                              <section data-component="status-band">
                                <div>
                                  <span>Багц</span>
                                  <strong>{planLabel(subscription().plan)}</strong>
                                  <code>{subscription().id}</code>
                                </div>
                                <div>
                                  <span>Төлөв</span>
                                  <strong>{subscriptionLabel(subscription().status)}</strong>
                                </div>
                                <div>
                                  <span>Хугацаа</span>
                                  <strong>
                                    {formatRange(subscription().timePeriodStart, subscription().timePeriodEnd)}
                                  </strong>
                                </div>
                                <div>
                                  <span>Холбогдсон нэхэмжлэх</span>
                                  <strong>{formatMoney(subscription().amount, subscription().currency)}</strong>
                                  <code>{subscription().invoiceID}</code>
                                </div>
                              </section>
                            )}
                          </Show>
                        </section>

                        <section data-component="data-section" aria-labelledby="workspace-usage-title">
                          <div data-component="section-heading">
                            <div>
                              <p data-component="eyebrow">Сүүлийн 30 хоногийн хэрэглээ</p>
                              <h2 id="workspace-usage-title">Ашиглалтын нийлбэр ба загварын задаргаа</h2>
                            </div>
                            <span>{formatRange(workspace.usage.periodStart, workspace.usage.periodEnd)}</span>
                          </div>
                          <section data-component="financial-metrics" aria-label="Ашиглалтын нийлбэр">
                            <Metric label="Хүсэлт" value={workspace.usage.aggregate.requests} />
                            <Metric label="Нийт токен" value={workspace.usage.aggregate.tokens} />
                            <Metric label="Оролтын токен" value={workspace.usage.aggregate.inputTokens} />
                            <Metric label="Өртөг" value={workspace.usage.aggregate.cost} kind="currency" />
                          </section>
                          <div data-component="table-scroll">
                            <table data-table="workspace-usage-models">
                              <thead>
                                <tr>
                                  <th>Үйлчилгээ / Загвар</th>
                                  <th>Хүсэлт</th>
                                  <th>Оролт</th>
                                  <th>Гаралт</th>
                                  <th>Бодолт</th>
                                  <th>Түр санах ой</th>
                                  <th>Өртөг</th>
                                </tr>
                              </thead>
                              <tbody>
                                <For
                                  each={workspace.usage.models}
                                  fallback={
                                    <tr>
                                      <td colspan="7" data-empty>
                                        Сүүлийн 30 хоногт хэрэглээний бүртгэл алга.
                                      </td>
                                    </tr>
                                  }
                                >
                                  {(usage) => (
                                    <tr>
                                      <td data-audit-action>
                                        <code title={`${usage.provider}/${usage.model}`}>{usage.provider}</code>
                                        <code title={usage.model}>{usage.model}</code>
                                      </td>
                                      <td>{formatNumber(usage.requests)}</td>
                                      <td>{formatNumber(usage.inputTokens)}</td>
                                      <td>{formatNumber(usage.outputTokens)}</td>
                                      <td>{formatNumber(usage.reasoningTokens)}</td>
                                      <td>{formatNumber(usage.cacheReadTokens + usage.cacheWriteTokens)}</td>
                                      <td>{formatMicroUsd(usage.cost)}</td>
                                    </tr>
                                  )}
                                </For>
                              </tbody>
                            </table>
                          </div>
                        </section>

                        <section data-component="data-section" aria-labelledby="workspace-invoices-title">
                          <div data-component="section-heading">
                            <div>
                              <p data-component="eyebrow">Сүүлийн төлбөрийн баримт</p>
                              <h2 id="workspace-invoices-title">Сүүлийн нэхэмжлэхүүд</h2>
                            </div>
                            <span>{workspace.invoices.length} мөр</span>
                          </div>
                          <div data-component="table-scroll">
                            <table data-table="workspace-invoices">
                              <thead>
                                <tr>
                                  <th>Нэхэмжлэх</th>
                                  <th>Үйлчилгээ</th>
                                  <th>Зориулалт</th>
                                  <th>Багц</th>
                                  <th>Дүн</th>
                                  <th>Төлөв</th>
                                  <th>Үүссэн</th>
                                </tr>
                              </thead>
                              <tbody>
                                <For
                                  each={workspace.invoices}
                                  fallback={
                                    <tr>
                                      <td colspan="7" data-empty>
                                        Нэхэмжлэхийн бүртгэл алга.
                                      </td>
                                    </tr>
                                  }
                                >
                                  {(invoice) => (
                                    <tr>
                                      <td data-workspace>
                                        <code>{invoice.id}</code>
                                      </td>
                                      <td>{invoice.provider}</td>
                                      <td>{invoice.purpose === "subscription" ? "Багц" : "Кредит"}</td>
                                      <td>{invoice.plan ? planLabel(invoice.plan) : "-"}</td>
                                      <td>{formatMoney(invoice.amount, invoice.currency)}</td>
                                      <td>
                                        <span data-payment-status={invoice.status}>
                                          {paymentStatusLabel(invoice.status)}
                                        </span>
                                      </td>
                                      <td>{formatDate(invoice.timeCreated)}</td>
                                    </tr>
                                  )}
                                </For>
                              </tbody>
                            </table>
                          </div>
                        </section>
                      </>
                    )
                  }}
                </Show>
              </section>
            </main>
          </>
        )}
      </Show>
    </>
  )
}

function directoryURL(
  filters: { q: string; limit: number; workspace?: string },
  cursor: string | undefined,
  workspace: string | undefined,
) {
  const search = new URLSearchParams()
  if (filters.q) search.set("q", filters.q)
  if (filters.limit !== 25) search.set("limit", String(filters.limit))
  if (cursor) search.set("cursor", cursor)
  if (workspace) search.set("workspace", workspace)
  const query = search.toString()
  return query ? `/workspaces?${query}` : "/workspaces"
}

function Metric(props: { label: string; value: number; kind?: "currency" }) {
  return (
    <article data-component="metric">
      <span>{props.label}</span>
      <strong>{props.kind === "currency" ? formatMicroUsd(props.value) : formatNumber(props.value)}</strong>
    </article>
  )
}

function subscriptionLabel(status: string) {
  return (
    {
      active: "Идэвхтэй",
      expired: "Дууссан",
      cancelled: "Цуцлагдсан",
      refunded: "Буцаагдсан",
    }[status] ?? `Тодорхойгүй (${status})`
  )
}

function paymentStatusLabel(status: string) {
  return (
    {
      created: "Үүссэн",
      pending: "Хүлээгдэж буй",
      paid: "Төлөгдсөн",
      failed: "Амжилтгүй",
      expired: "Хугацаа дууссан",
      cancelled: "Цуцлагдсан",
      refunded: "Буцаагдсан",
    }[status] ?? `Тодорхойгүй (${status})`
  )
}

function planLabel(plan: string) {
  return (
    {
      basic: "Basic",
      pro: "Pro",
      max: "Max",
    }[plan] ?? plan
  )
}

function formatRange(start: string, end: string) {
  return `${formatDate(start)} - ${formatDate(end)}`
}

function formatMoney(amount: number | null, currency: string | null) {
  if (amount === null || !currency) return "Мэдээлэлгүй"
  return new Intl.NumberFormat("mn-MN").format(amount) + ` ${currency}`
}

function formatMicroUsd(value: number) {
  return new Intl.NumberFormat("mn-MN", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value / 1_000_000)
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
