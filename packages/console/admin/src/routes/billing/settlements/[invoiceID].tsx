import { Title } from "@solidjs/meta"
import { A, action, createAsync, query, useParams, useSubmission } from "@solidjs/router"
import { For, Show } from "solid-js"
import { getRequestEvent } from "solid-js/web"
import { AdminHeader } from "~/component/admin-header"
import { AdminActionMessage } from "~/component/admin-action-message"
import { getAdminFinanceSettlement, recordAdminFinanceSettlement } from "~/lib/admin-finance-settlement"
import { getPlatformAdminContext } from "~/lib/admin-context"
import { adminResponse } from "~/lib/admin-response"
import { formatAdminDate } from "~/lib/admin-date"
import { adminPaymentStatusLabel } from "~/lib/admin-labels"

const settlementQuery = query(async (invoiceID: string) => {
  "use server"
  return adminResponse(() => getAdminFinanceSettlement(getPlatformAdminContext(), invoiceID))
}, "admin.billing.settlements")

const settlementAction = action(async (form: FormData) => {
  "use server"
  return adminResponse(() => {
    const event = getRequestEvent()
    if (!event) throw new Error("Админы хүсэлтийн орчин олдсонгүй.")
    return recordAdminFinanceSettlement(getPlatformAdminContext(), event.request, Object.fromEntries(form.entries()))
  })
}, "admin.billing.settle")

export default function AdminFinanceSettlementPage() {
  const params = useParams<{ invoiceID: string }>()
  const data = createAsync(() => settlementQuery(params.invoiceID))
  const submission = useSubmission(settlementAction)
  return (
    <>
      <Title>Тооцоо нийлүүлэлт | MongolGPT</Title>
      <Show
        when={data()}
        fallback={
          <main data-page="admin-billing" role="status">
            Тооцооны мэдээллийг ачаалж байна...
          </main>
        }
      >
        {(current) => {
          const kinds = () =>
            (["payment", "refund"] as const).filter(
              (kind) =>
                (kind === "payment"
                  ? ["paid", "refunded"].includes(current().invoice?.status ?? "")
                  : current().invoice?.status === "refunded") &&
                !current().settlements.some((item) => item.kind === kind),
            )
          return (
            <>
              <AdminHeader admin={current().admin} active="billing" />
              <main data-page="admin-billing">
                <A href="/billing">Санхүүгийн хяналт</A>
                <section data-component="page-heading">
                  <h1>Тооцоо нийлүүлэлт</h1>
                </section>
                <AdminActionMessage result={submission.result} error={submission.error} />
                <Show when={current().invoice} fallback={<p role="alert">Нэхэмжлэх олдсонгүй.</p>}>
                  {(invoice) => (
                    <>
                      <section data-component="settlement-invoice" aria-label="Нэхэмжлэхийн мэдээлэл">
                        <dl>
                          <div>
                            <dt>Нэхэмжлэх</dt>
                            <dd>
                              <code>{invoice().id}</code>
                            </dd>
                          </div>
                          <div>
                            <dt>Төлбөрийн суваг</dt>
                            <dd>{invoice().provider === "qpay" ? "QPay" : "Bonum"}</dd>
                          </div>
                          <div>
                            <dt>Мерчант</dt>
                            <dd>{invoice().merchantAccountID}</dd>
                          </div>
                          <div>
                            <dt>Гадаад нэхэмжлэх</dt>
                            <dd>{invoice().externalInvoiceID}</dd>
                          </div>
                          <div>
                            <dt>Төлөв</dt>
                            <dd>{adminPaymentStatusLabel(invoice().status)}</dd>
                          </div>
                          <div>
                            <dt>Нэхэмжилсэн дүн</dt>
                            <dd>{formatMNT(invoice().amount)}</dd>
                          </div>
                        </dl>
                      </section>
                      <section data-component="data-section" aria-labelledby="settlement-records-title">
                        <h2 id="settlement-records-title">Бүртгэгдсэн тооцоо</h2>
                        <div data-component="table-scroll">
                          <table>
                            <thead>
                              <tr>
                                <th>Баримтын дугаар</th>
                                <th>Төрөл</th>
                                <th>Нийт дүн</th>
                                <th>Шимтгэл</th>
                                <th>Татвар</th>
                                <th>Цэвэр дүн</th>
                                <th>Огноо</th>
                              </tr>
                            </thead>
                            <tbody>
                              <For
                                each={current().settlements}
                                fallback={
                                  <tr>
                                    <td colspan="7">Тооцоо нийлүүлэлтийн баримт бүртгэгдээгүй.</td>
                                  </tr>
                                }
                              >
                                {(item) => (
                                  <tr>
                                    <td>{item.externalSettlementID}</td>
                                    <td>
                                      {item.kind === "payment"
                                        ? "Төлбөр"
                                        : item.kind === "refund"
                                          ? "Буцаалт"
                                          : "Залруулга"}
                                    </td>
                                    <For
                                      each={[
                                        item.grossAmountMNT,
                                        item.feeAmountMNT,
                                        item.taxAmountMNT,
                                        item.netAmountMNT,
                                      ]}
                                    >
                                      {(amount) => <td>{formatMNT(amount)}</td>}
                                    </For>
                                    <td>{formatAdminDate(item.effectiveAt)}</td>
                                  </tr>
                                )}
                              </For>
                            </tbody>
                          </table>
                        </div>
                      </section>
                      <Show when={current().canRecord && kinds().length > 0}>
                        <section data-component="data-section" aria-labelledby="settlement-form-title">
                          <h2 id="settlement-form-title">Баталгаажуулсан мерчантын тооцоо</h2>
                          <form
                            action={settlementAction}
                            method="post"
                            data-component="settlement-form"
                            aria-label="Мерчантын тооцоо бүртгэх"
                          >
                            <input type="hidden" name="invoiceID" value={invoice().id} />
                            <label>
                              <span>Төрөл</span>
                              <select name="kind" value={kinds()[0]} required>
                                <For each={kinds()}>
                                  {(kind) => (
                                    <option value={kind} selected={kind === kinds()[0]}>
                                      {kind === "payment" ? "Төлбөр" : "Буцаалт"}
                                    </option>
                                  )}
                                </For>
                              </select>
                            </label>
                            <label>
                              <span>Тооцооны цаг (Улаанбаатар)</span>
                              <input name="effectiveAt" placeholder="ЖЖЖЖ-СС-ӨӨ ЦЦ:ММ" maxlength="19" required />
                            </label>
                            <label>
                              <span>Тооцооны баримтын давтагдашгүй дугаар</span>
                              <input name="externalSettlementID" maxlength="255" required />
                            </label>
                            <label>
                              <span>Мерчантын тайлангийн лавлагаа</span>
                              <input name="statementReference" maxlength="255" required />
                            </label>
                            <For
                              each={[
                                { name: "grossAmountMNT", label: "Нийт дүн (₮)" },
                                { name: "feeAmountMNT", label: "Суутгасан шимтгэл (₮)" },
                                { name: "taxAmountMNT", label: "Суутгасан татвар (₮)" },
                                { name: "netAmountMNT", label: "Цэвэр дүн (₮)" },
                              ]}
                            >
                              {(field) => (
                                <label>
                                  <span>{field.label}</span>
                                  <input name={field.name} type="number" step="1" required />
                                </label>
                              )}
                            </For>
                            <label data-confirmation>
                              <input type="checkbox" name="confirmation" value="verified" required />
                              <span>Дүн, мерчант, нэхэмжлэхийг эх баримттай тулгаж баталгаажуулсан.</span>
                            </label>
                            <button type="submit" disabled={submission.pending}>
                              {submission.pending ? "Хадгалж байна..." : "Тооцоо бүртгэх"}
                            </button>
                          </form>
                        </section>
                      </Show>
                    </>
                  )}
                </Show>
              </main>
            </>
          )
        }}
      </Show>
    </>
  )
}

function formatMNT(amount: number) {
  return `${new Intl.NumberFormat("en-US").format(amount)} ₮`
}
