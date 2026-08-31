import { Title } from "@solidjs/meta"
import { createAsync, query, useSearchParams } from "@solidjs/router"
import { ErrorBoundary, Show } from "solid-js"
import { AdminBillingView } from "~/component/admin-billing"
import { adminBillingQuery } from "~/lib/admin-billing-query"
import { getPlatformAdminContext } from "~/lib/admin-context"
import { listAdminPaymentRecoveries } from "~/lib/admin-payment-recovery"
import { adminPaymentRecoveryQueryKey } from "~/lib/admin-payment-recovery-query"

export const adminPaymentRecoveryListQuery = query(async () => {
  "use server"
  return listAdminPaymentRecoveries(getPlatformAdminContext())
}, adminPaymentRecoveryQueryKey)

export default function AdminBillingPage() {
  const [search] = useSearchParams()
  const billing = createAsync(() =>
    Promise.all([
      adminBillingQuery({
        period: typeof search.period === "string" ? search.period : "30d",
        provider: typeof search.provider === "string" ? search.provider : "all",
        status: typeof search.status === "string" ? search.status : "all",
      }),
      adminPaymentRecoveryListQuery(),
    ]),
  )

  return (
    <>
      <Title>Санхүүгийн хяналт | MongolGPT</Title>
      <ErrorBoundary fallback={<BillingError />}>
        <Show
          when={billing()}
          fallback={
            <main data-page="admin-billing">
              <section data-component="loading" aria-live="polite">
                Санхүүгийн мэдээллийг ачаалж байна...
              </section>
            </main>
          }
        >
          {(data) => {
            const [report, recoveries] = data()
            return <AdminBillingView data={report} recoveries={recoveries} />
          }}
        </Show>
      </ErrorBoundary>
    </>
  )
}

function BillingError() {
  return (
    <main data-page="admin-billing">
      <section data-component="empty" role="alert">
        Санхүүгийн сэргээх мэдээллийг ачаалж чадсангүй. Дахин оролдоно уу.
      </section>
    </main>
  )
}
