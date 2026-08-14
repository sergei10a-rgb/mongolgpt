import { Title } from "@solidjs/meta"
import { createAsync, useSearchParams } from "@solidjs/router"
import { Show } from "solid-js"
import { AdminBillingView } from "~/component/admin-billing"
import { adminBillingQuery } from "~/lib/admin-billing-query"

export default function AdminBillingPage() {
  const [search] = useSearchParams()
  const billing = createAsync(() =>
    adminBillingQuery({
      period: typeof search.period === "string" ? search.period : "30d",
      provider: typeof search.provider === "string" ? search.provider : "all",
      status: typeof search.status === "string" ? search.status : "all",
    }),
  )

  return (
    <>
      <Title>Санхүүгийн хяналт | MongolGPT</Title>
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
        {(data) => <AdminBillingView data={data()} />}
      </Show>
    </>
  )
}
