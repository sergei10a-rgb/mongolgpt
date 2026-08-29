import { Title } from "@solidjs/meta"
import { A, createAsync, query, useParams } from "@solidjs/router"
import { For, Show } from "solid-js"
import { AdminHeader } from "~/component/admin-header"
import { getPlatformAdminContext } from "~/lib/admin-context"
import { getAdminUserDetail } from "~/lib/admin-users"

export const adminUserDetailQuery = query(
  async (input: { accountID: string }) => {
    "use server"
    return getAdminUserDetail(getPlatformAdminContext(), input)
  },
  "admin.users.detail",
)

export default function AdminUserDetailPage() {
  const params = useParams()
  const detail = createAsync(() => adminUserDetailQuery({ accountID: params.accountID ?? "" }))

  return (
    <>
      <Title>Хэрэглэгчийн дэлгэрэнгүй | MongolGPT</Title>
      <Show
        when={detail()}
        fallback={
          <main data-page="admin-users">
            <section data-component="loading" aria-live="polite">
              Хэрэглэгчийн дэлгэрэнгүй мэдээллийг ачаалж байна...
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
                  <p data-component="eyebrow">Хэрэглэгч, багц, хэрэглээ, төлбөрийн нэгдсэн харалт</p>
                  <h1>Хэрэглэгчийн дэлгэрэнгүй</h1>
                </div>
                <A href="/users" data-component="back-link">
                  Жагсаалт руу буцах
                </A>
              </section>

              <section data-component="user-detail" aria-labelledby="user-detail-title">
                <div data-component="section-heading">
                  <div>
                    <p data-component="eyebrow">Таних мэдээлэл, төлөв, ажлын орон зай, багц, хэрэглээ, төлбөр</p>
                    <h2 id="user-detail-title">Сонгосон аккаунт</h2>
                  </div>
                  <span>Шинэчилсэн: {formatDate(data().generatedAt)}</span>
                </div>

                <Show when={data().account} fallback={<p data-component="empty">Хэрэглэгчийн бүртгэл олдсонгүй.</p>}>
                  {(selected) => {
                    const account = selected()
                    return (
                      <>
                        <section data-component="status-band">
                          <div>
                            <span>Аккаунт</span>
                            <strong>{account.id}</strong>
                            <code>{account.identities.find((item) => item.provider === "email")?.subject ?? "Имэйлгүй"}</code>
                          </div>
                          <div>
                            <span>Төлөв</span>
                            <strong>{account.status === "suspended" ? "Түдгэлзсэн" : "Идэвхтэй"}</strong>
                            <Show when={account.reason}>
                              <code>{account.reason}</code>
                            </Show>
                          </div>
                          <div>
                            <span>Орон зай</span>
                            <strong>{formatNumber(account.totals.workspaces)}</strong>
                            <code>{formatNumber(account.totals.freeWorkspaces)} free</code>
                          </div>
                          <div>
                            <span>Үүссэн / түдгэлзсэн</span>
                            <strong>{formatDate(account.timeCreated)}</strong>
                            <code>{formatDate(account.timeSuspended)}</code>
                          </div>
                        </section>

                        <section data-component="data-section" aria-labelledby="identity-title">
                          <div data-component="section-heading">
                            <div>
                              <p data-component="eyebrow">Нэвтрэх үйлчилгээ бүрийн баталгаажсан таних утга</p>
                              <h2 id="identity-title">Аккаунтын таних мэдээлэл</h2>
                            </div>
                            <span>{account.identities.length} мөр</span>
                          </div>
                          <div data-component="table-scroll">
                            <table data-table="user-identities">
                              <thead>
                                <tr>
                                  <th>Үйлчилгээ</th>
                                  <th>Таних утга</th>
                                  <th>Үүссэн</th>
                                  <th>Шинэчлэгдсэн</th>
                                </tr>
                              </thead>
                              <tbody>
                                <For
                                  each={account.identities}
                                  fallback={
                                    <tr>
                                      <td colspan="4" data-empty>
                                        Таних мэдээлэл алга.
                                      </td>
                                    </tr>
                                  }
                                >
                                  {(identity) => (
                                    <tr>
                                      <td>{identity.provider}</td>
                                      <td>
                                        <code>{identity.subject}</code>
                                      </td>
                                      <td>{formatDate(identity.timeCreated)}</td>
                                      <td>{formatDate(identity.timeUpdated)}</td>
                                    </tr>
                                  )}
                                </For>
                              </tbody>
                            </table>
                          </div>
                        </section>

                        <section data-component="data-section" aria-labelledby="workspace-title">
                          <div data-component="section-heading">
                            <div>
                              <p data-component="eyebrow">Ажлын орон зай болон хэрэглэгчийн бүртгэл</p>
                              <h2 id="workspace-title">Оролцож буй ажлын орон зай</h2>
                            </div>
                            <span>
                              Basic {formatNumber(account.totals.plans.basic)} · Pro {formatNumber(account.totals.plans.pro)} · Max {formatNumber(account.totals.plans.max)}
                            </span>
                          </div>
                          <div data-component="table-scroll">
                            <table data-table="user-workspaces">
                              <thead>
                                <tr>
                                  <th>Орон зай</th>
                                  <th>Эрх</th>
                                  <th>Багц</th>
                                  <th>Захиалга</th>
                                  <th>Хэрэглээний төлөв</th>
                                  <th>Сүүлд ашигласан</th>
                                </tr>
                              </thead>
                              <tbody>
                                <For
                                  each={account.workspaces}
                                  fallback={
                                    <tr>
                                      <td colspan="6" data-empty>
                                        Ажлын орон зайн бүртгэл алга.
                                      </td>
                                    </tr>
                                  }
                                >
                                  {(workspace) => (
                                    <tr>
                                      <td data-workspace>
                                        <strong>{workspace.workspaceName}</strong>
                                        <code>{workspace.workspaceID}</code>
                                        <Show when={workspace.workspaceSlug}>
                                          <small>{workspace.workspaceSlug}</small>
                                        </Show>
                                      </td>
                                      <td>{workspace.role === "admin" ? "Админ" : "Гишүүн"}</td>
                                      <td>{workspace.currentPlan ? planLabel(workspace.currentPlan) : "Үнэгүй"}</td>
                                      <td>
                                        <Show when={workspace.subscription} fallback="Идэвхтэй захиалга алга">
                                          {(subscription) => (
                                            <span>
                                              {planLabel(subscription().plan)} · {subscriptionLabel(subscription().status)}
                                            </span>
                                          )}
                                        </Show>
                                      </td>
                                      <td>
                                        <span data-component="inline-stack">
                                          <strong>{formatMicroUsd(workspace.usageSnapshot.monthlyCost.used)}</strong>
                                          <small>{formatNumber(workspace.usageSnapshot.monthlyTokens.used)} токен</small>
                                        </span>
                                      </td>
                                      <td>{formatDate(workspace.timeSeen)}</td>
                                    </tr>
                                  )}
                                </For>
                              </tbody>
                            </table>
                          </div>
                        </section>

                        <section data-component="data-section" aria-labelledby="limits-title">
                          <div data-component="section-heading">
                            <div>
                              <p data-component="eyebrow">Багц ба хэрэглэгчийн квотын төлөв</p>
                              <h2 id="limits-title">Багц, захиалга, хэрэглээний төлөв</h2>
                            </div>
                          </div>
                          <div data-component="table-scroll">
                            <table data-table="user-limits">
                              <thead>
                                <tr>
                                  <th>Орон зай</th>
                                  <th>7 хоног</th>
                                  <th>Сар</th>
                                  <th>Гулсах хугацаа</th>
                                  <th>Лимит</th>
                                </tr>
                              </thead>
                              <tbody>
                                <For
                                  each={account.workspaces}
                                  fallback={
                                    <tr>
                                      <td colspan="5" data-empty>
                                        Квотын төлөв алга.
                                      </td>
                                    </tr>
                                  }
                                >
                                  {(workspace) => (
                                    <tr>
                                      <td data-workspace>
                                        <strong>{workspace.workspaceName}</strong>
                                        <code>{workspace.userID}</code>
                                      </td>
                                      <td>
                                        {formatMicroUsd(workspace.usageSnapshot.weeklyCost.used)} ·{" "}
                                        {formatNumber(workspace.usageSnapshot.weeklyRequests.used)}
                                      </td>
                                      <td>
                                        {formatMicroUsd(workspace.usageSnapshot.monthlyCost.used)} ·{" "}
                                        {formatNumber(workspace.usageSnapshot.monthlyRequests.used)}
                                      </td>
                                      <td>{formatMicroUsd(workspace.usageSnapshot.rollingCost.used)}</td>
                                      <td>{renderLimits(workspace.limits)}</td>
                                    </tr>
                                  )}
                                </For>
                              </tbody>
                            </table>
                          </div>
                        </section>

                        <section data-component="data-section" aria-labelledby="usage-title">
                          <div data-component="section-heading">
                            <div>
                              <p data-component="eyebrow">Сүүлийн 30 хоногт тухайн аккаунтад хамааруулсан хэрэглээ</p>
                              <h2 id="usage-title">Хэрэглээ ба загварын зардлын хураангуй</h2>
                            </div>
                            <span>{formatRange(account.usage.periodStart, account.usage.periodEnd)}</span>
                          </div>
                          <section data-component="financial-metrics" aria-label="Хэрэглээний нийлбэр">
                            <Metric label="Хүсэлт" value={account.usage.aggregate.requests} />
                            <Metric label="Нийт токен" value={account.usage.aggregate.tokens} />
                            <Metric label="Хэрэглээний өртөг" value={account.usage.aggregate.cost} kind="currency" />
                            <Metric label="Загварын зардал" value={account.modelCost.totalMNTMicros} kind="mnt" />
                          </section>
                          <div data-component="table-scroll">
                            <table data-table="user-usage-models">
                              <thead>
                                <tr>
                                  <th>Үйлчилгээ / Загвар</th>
                                  <th>Хүсэлт</th>
                                  <th>Оролт</th>
                                  <th>Гаралт</th>
                                  <th>Токен</th>
                                  <th>Хэрэглээний өртөг</th>
                                </tr>
                              </thead>
                              <tbody>
                                <For
                                  each={account.usage.models}
                                  fallback={
                                    <tr>
                                      <td colspan="6" data-empty>
                                        Хэрэглээний бүртгэл алга.
                                      </td>
                                    </tr>
                                  }
                                >
                                  {(usage) => (
                                    <tr>
                                      <td data-audit-action>
                                        <code>{usage.provider}</code>
                                        <code>{usage.model}</code>
                                      </td>
                                      <td>{formatNumber(usage.requests)}</td>
                                      <td>{formatNumber(usage.inputTokens)}</td>
                                      <td>{formatNumber(usage.outputTokens)}</td>
                                      <td>{formatNumber(usage.tokens)}</td>
                                      <td>{formatMicroUsd(usage.cost)}</td>
                                    </tr>
                                  )}
                                </For>
                              </tbody>
                            </table>
                          </div>
                        </section>

                        <section data-component="data-section" aria-labelledby="payment-title">
                          <div data-component="section-heading">
                            <div>
                              <p data-component="eyebrow">Аккаунтаас эхлүүлсэн нэхэмжлэх ба тооцоо нийлүүлэлт</p>
                              <h2 id="payment-title">Төлбөрийн хураангуй</h2>
                            </div>
                            <span>{formatNumber(account.paymentSummary.invoices)} нэхэмжлэх</span>
                          </div>
                          <section data-component="financial-metrics" aria-label="Төлбөрийн нийлбэр">
                            <Metric label="Нийт орлого" value={account.paymentSummary.grossMNT} kind="mnt-base" />
                            <Metric label="Буцаалт" value={account.paymentSummary.refundedMNT} kind="mnt-base" />
                            <Metric label="Цэвэр орлого" value={account.paymentSummary.netMNT} kind="mnt-base" />
                            <Metric label="Шимтгэл" value={account.paymentSummary.feeMNTMicros} kind="mnt" />
                            <Metric label="Татвар" value={account.paymentSummary.taxMNTMicros} kind="mnt" />
                            <Metric
                              label="Хүлээн зөвшөөрсөн орлого"
                              value={account.paymentSummary.recognizedRevenueMNTMicros}
                              kind="mnt"
                            />
                            <Metric label="Нийт ашиг" value={account.paymentSummary.grossMarginMNTMicros} kind="mnt" />
                          </section>
                          <Show when={account.paymentSummary.marginReasons.length > 0}>
                            <p data-component="notice">
                              Нийт ашгийг тооцоогүй: {account.paymentSummary.marginReasons.map(marginReasonLabel).join(", ")}.
                            </p>
                          </Show>
                          <div data-component="table-scroll">
                            <table data-table="user-payments">
                              <thead>
                                <tr>
                                  <th>Нэхэмжлэх</th>
                                  <th>Орон зай</th>
                                  <th>Үйлчилгээ</th>
                                  <th>Багц</th>
                                  <th>Дүн</th>
                                  <th>Төлөв</th>
                                  <th>Үүссэн</th>
                                </tr>
                              </thead>
                              <tbody>
                                <For
                                  each={account.paymentSummary.invoicesRecent}
                                  fallback={
                                    <tr>
                                      <td colspan="7" data-empty>
                                        Төлбөрийн баримт алга.
                                      </td>
                                    </tr>
                                  }
                                >
                                  {(invoice) => (
                                    <tr>
                                      <td>
                                        <code>{invoice.id}</code>
                                      </td>
                                      <td data-workspace>
                                        <strong>{invoice.workspaceName}</strong>
                                        <code>{invoice.workspaceID}</code>
                                      </td>
                                      <td>{invoice.provider}</td>
                                      <td>{invoice.plan ? planLabel(invoice.plan) : "Кредит"}</td>
                                      <td>{formatMoney(invoice.amount, invoice.currency)}</td>
                                      <td>
                                        <span data-payment-status={invoice.status}>{paymentStatusLabel(invoice.status)}</span>
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

function Metric(props: { label: string; value: number | null; kind?: "currency" | "mnt" | "mnt-base" }) {
  return (
    <article data-component="metric">
      <span>{props.label}</span>
      <strong>
        {props.value === null
          ? "Тооцоолох боломжгүй"
          : props.kind === "currency"
          ? formatMicroUsd(props.value)
          : props.kind === "mnt"
            ? formatMNTMicros(props.value)
            : props.kind === "mnt-base"
              ? formatMNT(props.value)
              : formatNumber(props.value)}
      </strong>
    </article>
  )
}

function marginReasonLabel(reason: string) {
  return {
    payment_provider_filter: "төлбөрийн үйлчилгээний шүүлтүүртэй",
    missing_model_costs: "загварын бодит өртгийн бүртгэл дутуу",
    unvalued_model_costs: "загварын өртөг MNT-өөр үнэлэгдээгүй",
    missing_payment_settlements: "төлбөрийн тооцоо нийлүүлэлт дутуу",
    ambiguous_payment_settlements: "төлбөрийн тооцоо нийлүүлэлт давхардсан",
  }[reason] ?? reason
}

function subscriptionLabel(status: string) {
  return { active: "Идэвхтэй", expired: "Дууссан", cancelled: "Цуцлагдсан", refunded: "Буцаагдсан" }[status] ?? status
}

function paymentStatusLabel(status: string) {
  return {
    created: "Үүссэн",
    pending: "Хүлээгдэж буй",
    paid: "Төлөгдсөн",
    failed: "Амжилтгүй",
    expired: "Хугацаа дууссан",
    cancelled: "Цуцлагдсан",
    refunded: "Буцаагдсан",
  }[status] ?? status
}

function planLabel(plan: string) {
  return { basic: "Basic", pro: "Pro", max: "Max" }[plan] ?? plan
}

function renderLimits(
  limits:
    | { promoTokens: number; dailyRequests: number; dailyRequestsFallback: number }
    | {
        weeklyCostLimit: number
        weeklyTokenLimit: number
        weeklyRequestLimit: number
        monthlyCostLimit: number
        monthlyTokenLimit: number
        monthlyRequestLimit: number
        rollingCostLimit: number
        rollingWindowHours: number
      },
) {
  if ("promoTokens" in limits) {
    return `Үнэгүй · ${formatNumber(limits.promoTokens)} урамшууллын токен`
  }
  return (
    <span>
      {formatMicroUsd(limits.weeklyCostLimit)} / {formatMicroUsd(limits.monthlyCostLimit)}
    </span>
  )
}

function formatMoney(amount: number | null, currency: string | null) {
  if (amount === null || !currency) return "Мэдээлэлгүй"
  return `${new Intl.NumberFormat("mn-MN").format(amount)} ${currency}`
}

function formatMNT(value: number) {
  return `${new Intl.NumberFormat("mn-MN").format(value)} MNT`
}

function formatMNTMicros(value: number) {
  return `${new Intl.NumberFormat("mn-MN").format(value / 1_000_000)} MNT`
}

function formatMicroUsd(value: number) {
  return new Intl.NumberFormat("mn-MN", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value / 1_000_000)
}

function formatRange(start: string, end: string) {
  return `${formatDate(start)} - ${formatDate(end)}`
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
