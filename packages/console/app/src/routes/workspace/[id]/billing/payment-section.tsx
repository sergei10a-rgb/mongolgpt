import { Actor } from "@mongolgpt/console-core/actor.js"
import {
  getWorkspacePaymentHistory,
  type WorkspacePaymentHistoryItem,
} from "@mongolgpt/console-core/payment-history.js"
import { createAsync, query, useParams } from "@solidjs/router"
import { ErrorBoundary, For, Show } from "solid-js"
import { withActor } from "~/context/auth.withActor"
import styles from "./payment-section.module.css"

const providerNames = { qpay: "QPay", bonum: "Bonum" } as const
const planNames = { basic: "Basic", pro: "Pro", max: "Max" } as const

const queryPaymentHistory = query(async (workspaceID: string) => {
  "use server"
  return withActor(async () => {
    Actor.assertAdmin()
    return getWorkspacePaymentHistory(Actor.workspace())
  }, workspaceID)
}, "subscription.billing.history")

export function PaymentSection() {
  const params = useParams()
  const history = createAsync(() => queryPaymentHistory(params.id!))

  return (
    <section class={styles.root} aria-labelledby="payment-history-title">
      <div data-slot="section-title">
        <h2 id="payment-history-title">Төлбөрийн түүх</h2>
        <p>Сүүлийн 25 QPay болон Bonum нэхэмжлэхийн одоогийн төлөв.</p>
      </div>
      <ErrorBoundary
        fallback={
          <div data-slot="error" role="alert">
            Төлбөрийн түүхийг ачаалж чадсангүй. Хуудсаа дахин ачаална уу.
          </div>
        }
      >
        <Show
          when={history()}
          fallback={
            <div data-slot="loading" role="status" aria-live="polite">
              Төлбөрийн түүхийг ачаалж байна...
            </div>
          }
        >
          {(items) => (
            <Show
              when={items().length > 0}
              fallback={
                <div data-slot="empty">
                  <strong>Төлбөрийн бүртгэл алга</strong>
                  <span>Нэхэмжлэх үүсгэсний дараа төлөв нь энд харагдана.</span>
                </div>
              }
            >
              <div data-slot="payments-table">
                <table>
                  <caption>QPay болон Bonum төлбөрийн сүүлийн 25 нэхэмжлэх</caption>
                  <thead>
                    <tr>
                      <th scope="col">Огноо</th>
                      <th scope="col">Багц</th>
                      <th scope="col" data-column="provider">
                        Суваг
                      </th>
                      <th scope="col">Дүн</th>
                      <th scope="col">Төлөв</th>
                      <th scope="col" data-column="invoice">
                        Нэхэмжлэх
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={items()}>{(payment) => <PaymentRow payment={payment} />}</For>
                  </tbody>
                </table>
              </div>
            </Show>
          )}
        </Show>
      </ErrorBoundary>
    </section>
  )
}

function PaymentRow(props: { payment: WorkspacePaymentHistoryItem }) {
  const occurred = () => new Date(props.payment.refundedAt ?? props.payment.verifiedAt ?? props.payment.createdAt)
  return (
    <tr data-status={props.payment.status}>
      <td>
        <time dateTime={occurred().toISOString()} title={occurred().toLocaleString("mn-MN")}>
          {formatDate(occurred())}
        </time>
      </td>
      <td>{props.payment.plan ? planNames[props.payment.plan] : purposeName(props.payment.purpose)}</td>
      <td data-column="provider">{providerNames[props.payment.provider]}</td>
      <td data-slot="amount">{formatMnt(props.payment.amount)}</td>
      <td>
        <span data-slot="status" data-status={props.payment.status}>
          {statusName(props.payment.status)}
        </span>
      </td>
      <td data-column="invoice">
        <code title={props.payment.invoiceID}>{props.payment.invoiceID}</code>
      </td>
    </tr>
  )
}

function formatMnt(amount: number) {
  return new Intl.NumberFormat("mn-MN", { style: "currency", currency: "MNT", maximumFractionDigits: 0 }).format(amount)
}

function formatDate(value: Date) {
  return new Intl.DateTimeFormat("mn-MN", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value)
}

function purposeName(purpose: WorkspacePaymentHistoryItem["purpose"]) {
  return purpose === "credit" ? "Нэмэлт эрх" : "Багц"
}

function statusName(status: WorkspacePaymentHistoryItem["status"]) {
  if (status === "created") return "Үүссэн"
  if (status === "pending") return "Хүлээгдэж байна"
  if (status === "paid") return "Төлөгдсөн"
  if (status === "failed") return "Амжилтгүй"
  if (status === "expired") return "Хугацаа дууссан"
  if (status === "cancelled") return "Цуцлагдсан"
  return "Буцаан олгосон"
}
