import { action, json, useSubmission } from "@solidjs/router"
import { For, Show } from "solid-js"
import { getRequestEvent } from "solid-js/web"
import type { FinanceMarginUnavailableReason } from "@mongolgpt/console-core/finance-reporting.js"
import type { PlatformAdminContext } from "~/lib/admin-context"
import { AdminHeader } from "./admin-header"
import { cancelAdminSubscriptionCheckout } from "~/lib/admin-billing"
import { adminBillingQuery } from "~/lib/admin-billing-query"
import { getPlatformAdminContext } from "~/lib/admin-context"

export const cancelAdminSubscriptionCheckoutAction = action(async (form: FormData) => {
  "use server"
  const event = getRequestEvent()
  if (!event) throw new Error("Админы хүсэлтийн орчин олдсонгүй.")
  const result = await cancelAdminSubscriptionCheckout(
    getPlatformAdminContext(),
    event.request,
    Object.fromEntries(form.entries()),
  )
  return json(result, { revalidate: adminBillingQuery.key })
}, "admin.billing.cancel")

export interface AdminBillingData {
  admin: PlatformAdminContext
  filters: {
    period: "7d" | "30d" | "90d"
    provider: "all" | "qpay" | "bonum"
    status: "all" | "created" | "pending" | "paid" | "failed" | "expired" | "cancelled" | "refunded"
  }
  period: {
    start: string
    end: string
  }
  metrics: {
    grossRevenueMNT: number
    refundsMNT: number
    netRevenueMNT: number
    paidInvoices: number
    refundedInvoices: number
    pendingInvoices: number
    activeSubscriptions: number
    estimatedModelCostMicroCents: number
    actualModelCostMNTMicros: number
    paymentCostMNTMicros: number | null
    recognizedRevenueMNTMicros: number | null
    requests: number
    tokens: number
  }
  finance: {
    model: {
      expectedUsage: number
      coveredUsage: number
      missingUsage: number
      valuedEntries: number
      unvaluedEntries: number
      debitMNTMicros: number
      creditMNTMicros: number
      costMNTMicros: number
      complete: boolean
    }
    payments: {
      expectedEvents: number
      coveredEvents: number
      missingEvents: number
      ambiguousEvents: number
      feeMNTMicros: number | null
      taxMNTMicros: number | null
      revenueAdjustmentMNTMicros: number | null
      costMNTMicros: number | null
      complete: boolean
    }
    margin: {
      available: boolean
      recognizedRevenueMNTMicros: number | null
      valueMNTMicros: number | null
      reasons: FinanceMarginUnavailableReason[]
    }
  }
  usage: {
    provider: string
    model: string
    requests: number
    inputTokens: number
    outputTokens: number
    reasoningTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    tokens: number
    cost: number
  }[]
  invoices: {
    id: string
    workspaceID: string
    workspaceName: string
    provider: "qpay" | "bonum"
    plan: "basic" | "pro" | "max" | null
    amount: number
    currency: "MNT"
    status: "created" | "pending" | "paid" | "failed" | "expired" | "cancelled" | "refunded"
    timeCreated: string
    timeVerified: string | null
    timeRefunded: string | null
    canCancel: boolean
    cancellationRequestKey: string | null
  }[]
  generatedAt: string
}

export function AdminBillingView(props: { data: AdminBillingData }) {
  const cancellationSubmission = useSubmission(cancelAdminSubscriptionCheckoutAction)
  const canCancelInvoices = () => props.data.invoices.some((invoice) => invoice.canCancel)
  return (
    <>
      <AdminHeader admin={props.data.admin} active="billing" />

      <main data-page="admin-billing">
        <section data-component="page-heading">
          <div>
            <p data-component="eyebrow">QPay + Bonum ба загварын өртөг</p>
            <h1>Санхүүгийн хяналт</h1>
          </div>
          <span data-component="read-only">Зөвхөн харах горим</span>
        </section>

        <form method="get" data-component="billing-filters" aria-label="Санхүүгийн мэдээлэл шүүх">
          <label>
            <span>Хугацаа</span>
            <select name="period" value={props.data.filters.period}>
              <option value="7d">Сүүлийн 7 хоног</option>
              <option value="30d">Сүүлийн 30 хоног</option>
              <option value="90d">Сүүлийн 90 хоног</option>
            </select>
          </label>
          <label>
            <span>Төлбөрийн суваг</span>
            <select name="provider" value={props.data.filters.provider}>
              <option value="all">Бүх суваг</option>
              <option value="qpay">QPay</option>
              <option value="bonum">Bonum</option>
            </select>
          </label>
          <label>
            <span>Нэхэмжлэхийн төлөв</span>
            <select name="status" value={props.data.filters.status}>
              <option value="all">Бүх төлөв</option>
              <option value="created">Үүссэн</option>
              <option value="pending">Хүлээгдэж буй</option>
              <option value="paid">Төлөгдсөн</option>
              <option value="failed">Амжилтгүй</option>
              <option value="expired">Хугацаа дууссан</option>
              <option value="cancelled">Цуцлагдсан</option>
              <option value="refunded">Буцаасан</option>
            </select>
          </label>
          <button type="submit">Шүүх</button>
        </form>

        <section data-component="financial-metrics" aria-label="Санхүүгийн үндсэн үзүүлэлт">
          <FinancialMetric
            label={
              props.data.metrics.recognizedRevenueMNTMicros === null ? "Нэхэмжлэхийн цэвэр орлого" : "Цэвэр орлого"
            }
            value={
              props.data.metrics.recognizedRevenueMNTMicros === null
                ? formatMNT(props.data.metrics.netRevenueMNT)
                : formatMNTMicros(props.data.metrics.recognizedRevenueMNTMicros)
            }
            detail={
              props.data.finance.payments.revenueAdjustmentMNTMicros === null
                ? "Тооцоо нийлүүлэлтийн баримт бүрдээгүй"
                : props.data.finance.payments.revenueAdjustmentMNTMicros === 0
                  ? undefined
                  : `${formatMNTMicros(props.data.finance.payments.revenueAdjustmentMNTMicros)} тооцооны засвар`
            }
            tone={props.data.metrics.recognizedRevenueMNTMicros === null ? "warning" : undefined}
          />
          <FinancialMetric
            label="Баталгаажсан төлбөр"
            value={formatMNT(props.data.metrics.grossRevenueMNT)}
            detail={`${formatNumber(props.data.metrics.paidInvoices)} нэхэмжлэх`}
          />
          <FinancialMetric
            label="Буцаалт"
            value={formatMNT(props.data.metrics.refundsMNT)}
            detail={`${formatNumber(props.data.metrics.refundedInvoices)} нэхэмжлэх`}
            tone={props.data.metrics.refundsMNT > 0 ? "warning" : undefined}
          />
          <FinancialMetric
            label={
              props.data.filters.provider === "all"
                ? "Загварын бодит өртөг"
                : "Загварын бодит өртөг (бүх төлбөрийн суваг)"
            }
            value={formatMNTMicros(props.data.metrics.actualModelCostMNTMicros)}
            detail={`${formatNumber(props.data.finance.model.coveredUsage)}/${formatNumber(
              props.data.finance.model.expectedUsage,
            )} хэрэглээ нотлогдсон`}
            tone={props.data.finance.model.complete ? undefined : "warning"}
          />
          <FinancialMetric
            label="Төлбөрийн шимтгэл ба татвар"
            value={
              props.data.metrics.paymentCostMNTMicros === null
                ? "Тооцоолоогүй"
                : formatMNTMicros(props.data.metrics.paymentCostMNTMicros)
            }
            detail={`${formatNumber(props.data.finance.payments.coveredEvents)}/${formatNumber(
              props.data.finance.payments.expectedEvents,
            )} үйл явдал нотлогдсон`}
            tone={props.data.finance.payments.complete ? undefined : "warning"}
          />
          <FinancialMetric
            label="Загварын урьдчилсан өртөг"
            value={formatUSD(props.data.metrics.estimatedModelCostMicroCents)}
            detail={`${formatNumber(props.data.metrics.requests)} хүсэлтийн үйлчилгээний тооцоо`}
          />
          <FinancialMetric label="Нийт токен" value={formatNumber(props.data.metrics.tokens)} />
          <FinancialMetric
            label="Идэвхтэй төлбөртэй багц"
            value={formatNumber(props.data.metrics.activeSubscriptions)}
          />
          <FinancialMetric
            label="Хүлээгдэж буй төлбөр"
            value={formatNumber(props.data.metrics.pendingInvoices)}
            tone={props.data.metrics.pendingInvoices > 0 ? "warning" : undefined}
          />
          <FinancialMetric
            label="Нийт ашигт ажиллагаа"
            value={
              props.data.finance.margin.available && props.data.finance.margin.valueMNTMicros !== null
                ? formatMNTMicros(props.data.finance.margin.valueMNTMicros)
                : "Тооцоолоогүй"
            }
            detail={marginDetail(props.data.finance.margin)}
            tone={props.data.finance.margin.available ? undefined : "warning"}
          />
        </section>

        <section data-component="finance-status">
          <div>
            <span>Загварын бодит өртөг</span>
            <strong>
              {formatNumber(props.data.finance.model.coveredUsage)} /{" "}
              {formatNumber(props.data.finance.model.expectedUsage)}
            </strong>
          </div>
          <div>
            <span>Төлбөрийн тооцоо нийлүүлэлт</span>
            <strong>
              {formatNumber(props.data.finance.payments.coveredEvents)} /{" "}
              {formatNumber(props.data.finance.payments.expectedEvents)}
            </strong>
          </div>
          <div>
            <span>Үнэлгээгүй өртгийн мөр</span>
            <strong>{formatNumber(props.data.finance.model.unvaluedEntries)}</strong>
          </div>
          <div>
            <span>Тайлангийн хугацаа</span>
            <strong>
              {formatDate(props.data.period.start)} - {formatDate(props.data.period.end)}
            </strong>
          </div>
        </section>

        <section data-component="data-section" aria-labelledby="model-cost-title">
          <div data-component="section-heading">
            <div>
              <p data-component="eyebrow">Нэгдсэн загварын үйлчилгээний хэрэглээ</p>
              <h2 id="model-cost-title">Үйлчилгээ ба загварын өртөг</h2>
            </div>
            <span>{props.data.usage.length} мөр</span>
          </div>
          <div data-component="table-scroll">
            <table data-table="model-cost">
              <thead>
                <tr>
                  <th>Үйлчилгээ</th>
                  <th>Загвар</th>
                  <th>Хүсэлт</th>
                  <th>Оролтын токен</th>
                  <th>Гаралтын токен</th>
                  <th>Нийт токен</th>
                  <th>Өртөг</th>
                </tr>
              </thead>
              <tbody>
                <For
                  each={props.data.usage}
                  fallback={
                    <tr>
                      <td colspan="7" data-empty>
                        Сонгосон хугацаанд загварын хэрэглээ алга.
                      </td>
                    </tr>
                  }
                >
                  {(usage) => (
                    <tr>
                      <td>{usage.provider}</td>
                      <td>
                        <code>{usage.model}</code>
                      </td>
                      <td>{formatNumber(usage.requests)}</td>
                      <td>{formatNumber(usage.inputTokens)}</td>
                      <td>{formatNumber(usage.outputTokens)}</td>
                      <td>{formatNumber(usage.tokens)}</td>
                      <td>{formatUSD(usage.cost)}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </section>

        <section data-component="data-section" aria-labelledby="invoice-title">
          <div data-component="section-heading">
            <div>
              <p data-component="eyebrow">Төлбөрийн баталгаажсан бүртгэл</p>
              <h2 id="invoice-title">Сүүлийн нэхэмжлэхүүд</h2>
            </div>
            <span>{props.data.invoices.length} мөр</span>
          </div>
          <Show when={cancellationSubmission.result}>
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
          <div data-component="table-scroll">
            <table data-table="payment-invoices">
              <thead>
                <tr>
                  <th>Нэхэмжлэх</th>
                  <th>Ажлын орон зай</th>
                  <th>Суваг</th>
                  <th>Багц</th>
                  <th>Дүн</th>
                  <th>Төлөв</th>
                  <th>Үүссэн</th>
                  <Show when={canCancelInvoices()}>
                    <th>Үйлдэл</th>
                  </Show>
                </tr>
              </thead>
              <tbody>
                <For
                  each={props.data.invoices}
                  fallback={
                    <tr>
                      <td colspan={canCancelInvoices() ? 8 : 7} data-empty>
                        Сонгосон нөхцөлд нэхэмжлэх алга.
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
                      <td>{paymentProviderLabel(invoice.provider)}</td>
                      <td>{planLabel(invoice.plan)}</td>
                      <td>{formatMNT(invoice.amount)}</td>
                      <td>
                        <span data-payment-status={invoice.status}>{paymentStatusLabel(invoice.status)}</span>
                      </td>
                      <td>{formatDate(invoice.timeCreated)}</td>
                      <Show when={canCancelInvoices()}>
                        <td>
                          <Show when={invoice.canCancel && invoice.cancellationRequestKey}>
                            <AdminCancellationAction
                              invoiceID={invoice.id}
                              requestKey={invoice.cancellationRequestKey!}
                              pending={Boolean(cancellationSubmission.pending)}
                            />
                          </Show>
                        </td>
                      </Show>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </section>

        <p data-component="report-generated">Шинэчилсэн: {formatDate(props.data.generatedAt)}</p>
      </main>
    </>
  )
}

function AdminCancellationAction(props: { invoiceID: string; requestKey: string; pending: boolean }) {
  return (
    <details data-component="payment-cancellation-action">
      <summary>QPay нэхэмжлэх цуцлах</summary>
      <form action={cancelAdminSubscriptionCheckoutAction} method="post">
        <input type="hidden" name="invoiceID" value={props.invoiceID} />
        <input type="hidden" name="requestKey" value={props.requestKey} />
        <label for={`cancel-reason-${props.invoiceID}`}>Цуцлах Монгол шалтгаан</label>
        <textarea id={`cancel-reason-${props.invoiceID}`} name="reason" minlength="20" maxlength="500" required />
        <label data-component="confirmation">
          <input type="checkbox" name="confirmation" value="cancel" required />
          Цуцлалтыг баталгаажуулж байна.
        </label>
        <button type="submit" disabled={props.pending}>
          {props.pending ? "Цуцалж байна..." : "Цуцлах"}
        </button>
      </form>
    </details>
  )
}

function FinancialMetric(props: { label: string; value: string; detail?: string; tone?: "warning" }) {
  return (
    <article data-component="metric" data-tone={props.tone}>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
      <Show when={props.detail}>{(detail) => <small>{detail()}</small>}</Show>
    </article>
  )
}

function formatMNT(value: number) {
  return new Intl.NumberFormat("mn-MN", {
    style: "currency",
    currency: "MNT",
    maximumFractionDigits: 0,
  }).format(value)
}

function formatMNTMicros(value: number) {
  return new Intl.NumberFormat("mn-MN", {
    style: "currency",
    currency: "MNT",
    minimumFractionDigits: 0,
    maximumFractionDigits: 6,
  }).format(value / 1_000_000)
}

function formatUSD(value: number) {
  return new Intl.NumberFormat("mn-MN", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value / 100_000_000)
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("mn-MN").format(value)
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("mn-MN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Ulaanbaatar",
  }).format(new Date(value))
}

function marginDetail(margin: AdminBillingData["finance"]["margin"]) {
  if (margin.available) return "Бодит загварын өртөг, шимтгэл, татварыг хассан"
  return margin.reasons.map(marginUnavailableReasonLabel).join(" · ")
}

function marginUnavailableReasonLabel(reason: FinanceMarginUnavailableReason) {
  return (
    {
      payment_provider_filter: "Төлбөрийн сувгаар шүүхэд загварын өртөг хуваарилагдахгүй",
      missing_model_costs: "Зарим хэрэглээний бодит өртөг дутуу",
      unvalued_model_costs: "Зарим USD өртөг MNT-д үнэлэгдээгүй",
      missing_payment_settlements: "Зарим төлбөрийн тооцоо нийлүүлэлтийн баримт дутуу",
      ambiguous_payment_settlements: "Давхардсан тооцоо нийлүүлэлтийн баримт шалгах шаардлагатай",
    }[reason] ?? reason
  )
}

function paymentProviderLabel(provider: string) {
  return provider === "qpay" ? "QPay" : provider === "bonum" ? "Bonum" : provider
}

function planLabel(plan: string | null) {
  return (
    {
      basic: "Basic",
      pro: "Pro",
      max: "Max",
    }[plan ?? ""] ?? "-"
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
      refunded: "Буцаасан",
    }[status] ?? status
  )
}
