import { For, Show } from "solid-js"
import type { PlatformAdminContext } from "~/lib/admin-context"
import { AdminHeader, roleLabel } from "./admin-header"

export interface AdminOverviewData {
  admin: PlatformAdminContext
  metrics: {
    accounts: number
    users: number
    workspaces: number
    subscriptions: number
    pendingPayments: number
    administrators: number
  }
  audit: {
    id: string
    actor: string
    action: string
    target: string | null
    outcome: "success" | "denied" | "failure"
    time: string
  }[]
  auditVisible: boolean
  generatedAt: string
}

export function AdminOverviewView(props: { data: AdminOverviewData }) {
  return (
    <>
      <AdminHeader admin={props.data.admin} active="overview" />

      <main data-page="admin-overview">
        <section data-component="page-heading">
          <div>
            <p data-component="eyebrow">Платформын төлөв</p>
            <h1>Ерөнхий хяналт</h1>
          </div>
          <span data-component="read-only">Зөвхөн харах горим</span>
        </section>

        <Show when={props.data.admin.bootstrapped}>
          <p data-component="notice">Анхны эзэмшигчийн эрх энэ баталгаажсан Cloudflare Access бүртгэлд үүслээ.</p>
        </Show>

        <section data-component="metrics" aria-label="Платформын үндсэн үзүүлэлт">
          <Metric label="Аккаунт" value={props.data.metrics.accounts} />
          <Metric label="Хэрэглэгч" value={props.data.metrics.users} />
          <Metric label="Ажлын орон зай" value={props.data.metrics.workspaces} />
          <Metric label="Идэвхтэй багц" value={props.data.metrics.subscriptions} />
          <Metric label="Шалгах төлбөр" value={props.data.metrics.pendingPayments} tone="warning" />
          <Metric label="Идэвхтэй админ" value={props.data.metrics.administrators} />
        </section>

        <section data-component="status-band">
          <div>
            <span>Cloudflare Access нэвтрэх хамгаалалт</span>
            <strong data-status="healthy">Баталгаажсан</strong>
          </div>
          <div>
            <span>Платформын эрх</span>
            <strong>{roleLabel(props.data.admin.role)}</strong>
          </div>
          <div>
            <span>Хүсэлтийн ID</span>
            <code>{props.data.admin.requestID}</code>
          </div>
          <div>
            <span>Шинэчилсэн</span>
            <strong>{formatDate(props.data.generatedAt)}</strong>
          </div>
        </section>

        <section data-component="audit-section">
          <div data-component="section-heading">
            <div>
              <p data-component="eyebrow">Аюулгүй байдлын бүртгэл</p>
              <h2>Сүүлийн админ үйлдлүүд</h2>
            </div>
          </div>

          <Show
            when={props.data.auditVisible}
            fallback={<p data-component="empty">Энэ эрхэд админы үйлдлийн бүртгэл харах зөвшөөрөл олгогдоогүй.</p>}
          >
            <div data-component="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Үйлдэл</th>
                    <th>Админ</th>
                    <th>Зорилт</th>
                    <th>Үр дүн</th>
                    <th>Огноо</th>
                  </tr>
                </thead>
                <tbody>
                  <For
                    each={props.data.audit}
                    fallback={
                      <tr>
                        <td colspan="5" data-empty>
                          Админы үйлдлийн бүртгэл хараахан алга.
                        </td>
                      </tr>
                    }
                  >
                    {(entry) => (
                      <tr>
                        <td>
                          <code>{entry.action}</code>
                        </td>
                        <td>{entry.actor}</td>
                        <td>{entry.target || "-"}</td>
                        <td>
                          <span data-outcome={entry.outcome}>{outcomeLabel(entry.outcome)}</span>
                        </td>
                        <td>{formatDate(entry.time)}</td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>
        </section>
      </main>
    </>
  )
}

function Metric(props: { label: string; value: number; tone?: "warning" }) {
  return (
    <article data-component="metric" data-tone={props.tone}>
      <span>{props.label}</span>
      <strong>{new Intl.NumberFormat("mn-MN").format(props.value)}</strong>
    </article>
  )
}

function outcomeLabel(outcome: string) {
  return (
    {
      success: "Амжилттай",
      denied: "Татгалзсан",
      failure: "Алдаатай",
    }[outcome] ?? outcome
  )
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("mn-MN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Ulaanbaatar",
  }).format(new Date(value))
}
