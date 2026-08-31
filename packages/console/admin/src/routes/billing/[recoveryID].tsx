import { Title } from "@solidjs/meta"
import { A, createAsync, query, useParams, useSubmission } from "@solidjs/router"
import { ErrorBoundary, Show } from "solid-js"
import { AdminHeader } from "~/component/admin-header"
import { paymentRecoveryStatusLabel, retryAdminPaymentRecoveryAction } from "~/component/admin-billing"
import { getPlatformAdminContext } from "~/lib/admin-context"
import { getAdminPaymentRecoveryDetail } from "~/lib/admin-payment-recovery"
import { adminPaymentRecoveryQueryKey } from "~/lib/admin-payment-recovery-query"

export const adminPaymentRecoveryDetailQuery = query(async (recoveryID: string) => {
  "use server"
  return getAdminPaymentRecoveryDetail(getPlatformAdminContext(), recoveryID)
}, adminPaymentRecoveryQueryKey)

export default function AdminPaymentRecoveryDetailPage() {
  const params = useParams()
  const detail = createAsync(() => adminPaymentRecoveryDetailQuery(params.recoveryID ?? ""))
  const submission = useSubmission(retryAdminPaymentRecoveryAction)

  return (
    <>
      <Title>Төлбөрийн сэргээх бүртгэл | MongolGPT</Title>
      <ErrorBoundary fallback={<RecoveryError />}>
        <Show
          when={detail()}
          fallback={
            <main data-page="admin-billing">
              <section data-component="loading" aria-live="polite">
                Төлбөрийн сэргээх бүртгэлийг ачаалж байна...
              </section>
            </main>
          }
        >
          {(data) => (
            <>
              <AdminHeader admin={data().admin} active="billing" />
              <main data-page="admin-billing">
                <Show
                  when={data().recovery}
                  fallback={
                    <>
                      <section data-component="page-heading">
                        <div>
                          <p data-component="eyebrow">
                            <A href="/billing">Санхүүгийн хяналт</A> / сэргээх бүртгэл
                          </p>
                          <h1>Сэргээх бүртгэл олдсонгүй</h1>
                        </div>
                        <A href="/billing" data-component="back-link">
                          Санхүү рүү буцах
                        </A>
                      </section>
                      <section data-component="empty" role="alert">
                        Энэ төлбөрийн сэргээх бүртгэл устсан эсвэл ID буруу байна.
                      </section>
                    </>
                  }
                >
                  {(selected) => {
                    const recovery = selected()
                    return (
                      <>
                        <section data-component="page-heading">
                          <div>
                            <p data-component="eyebrow">
                              <A href="/billing">Санхүүгийн хяналт</A> / {recovery.id}
                            </p>
                            <h1>Төлбөрийн сэргээх бүртгэл</h1>
                          </div>
                          <A href="/billing" data-component="back-link">
                            Санхүү рүү буцах
                          </A>
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

                        <section data-component="status-band" data-payment-recovery-detail>
                          <div>
                            <span>Сэргээх бүртгэлийн ID</span>
                            <strong>{recovery.id}</strong>
                            <code>{recovery.messageHash}</code>
                          </div>
                          <div>
                            <span>Төлөв</span>
                            <strong>{paymentRecoveryStatusLabel(recovery.status)}</strong>
                            <code>{recovery.lastErrorCode ?? "Сүүлийн алдаа байхгүй"}</code>
                          </div>
                          <div>
                            <span>Суваг</span>
                            <strong>{providerLabel(recovery.provider)}</strong>
                            <code>{recovery.merchantAccountID ?? "төлбөр хүлээн авагчийн ID байхгүй"}</code>
                          </div>
                          <div>
                            <span>Оролдлого</span>
                            <strong>{formatNumber(recovery.attempts)}</strong>
                            <code>{recovery.validEvent ? "Үйл явдал хадгалсан" : "Үйл явдал хүчингүй"}</code>
                          </div>
                        </section>

                        <section data-component="data-section" aria-labelledby="recovery-detail-title">
                          <div data-component="section-heading">
                            <div>
                              <p data-component="eyebrow">Архивласан үйл явдлын аюулгүй метадата</p>
                              <h2 id="recovery-detail-title">Сэргээх мэдээлэл</h2>
                            </div>
                            <span>Шинэчилсэн: {formatDate(recovery.timeUpdated)}</span>
                          </div>
                          <section data-component="recovery-detail-grid">
                            <DetailItem label="Гадаад үйл явдлын ID" value={recovery.externalEventID} />
                            <DetailItem label="Гадаад нэхэмжлэхийн ID" value={recovery.externalInvoiceID} />
                            <DetailItem label="Гадаад төлбөрийн ID" value={recovery.externalPaymentID ?? null} />
                            <DetailItem label="Үйл явдлын төрөл" value={recovery.eventType ?? null} />
                            <DetailItem
                              label="Дүн"
                              value={
                                recovery.amount == null
                                  ? null
                                  : `${formatNumber(recovery.amount)} ${recovery.currency ?? ""}`.trim()
                              }
                            />
                            <DetailItem label="Ачааллын хэш" value={recovery.payloadHash ?? null} code />
                            <DetailItem label="Үүссэн" value={formatDate(recovery.timeCreated)} />
                            <DetailItem label="Шинэчлэгдсэн" value={formatDate(recovery.timeUpdated)} />
                            <DetailItem label="Дараагийн оролдлого" value={formatDate(recovery.timeNextAttempt)} />
                            <DetailItem label="Түр эзэмшлийн хугацаа" value={formatDate(recovery.timeLeaseExpires)} />
                            <DetailItem label="Шийдэгдсэн" value={formatDate(recovery.timeResolved)} />
                            <DetailItem label="Үйл явдал болсон цаг" value={formatDate(recovery.occurredAt)} />
                            <DetailItem label="Дараалалд орсон цаг" value={formatDate(recovery.enqueuedAt)} />
                          </section>
                        </section>

                        <section data-component="recovery-guardrail" aria-labelledby="recovery-guardrail-title">
                          <div data-component="section-heading">
                            <div>
                              <p data-component="eyebrow">Алдаанд хаалттай давтан оролдлогын хамгаалалт</p>
                              <h2 id="recovery-guardrail-title">Удирдах үйлдэл</h2>
                            </div>
                          </div>
                          <Show
                            when={data().canRetry && recovery.retryRequestKey}
                            fallback={
                              <p data-component="notice" data-tone="warning">
                                {recovery.retryDisabledReason ??
                                  "Энэ сэргээх бүртгэлд гараар давтан оролдох боломжгүй байна."}
                              </p>
                            }
                          >
                            <form
                              action={retryAdminPaymentRecoveryAction}
                              method="post"
                              data-component="payment-recovery-action"
                              aria-label="Төлбөрийн сэргээх бүртгэлийг хуваарьт ажилд буцаан оруулах"
                            >
                              <input type="hidden" name="recoveryID" value={recovery.id} />
                              <input type="hidden" name="requestKey" value={recovery.retryRequestKey!} />
                              <label for={`retry-reason-${recovery.id}`}>Давтан оролдох шалтгаан</label>
                              <textarea
                                id={`retry-reason-${recovery.id}`}
                                name="reason"
                                minlength="20"
                                maxlength="500"
                                required
                                rows="4"
                                placeholder="Яагаад гараар давтан оролдож байгааг Монгол хэлээр тэмдэглэнэ үү"
                              />
                              <label data-component="confirmation">
                                <input type="checkbox" name="confirmation" value="retry" required />
                                Зөвхөн энэ хадгалсан сэргээх бүртгэлийг хүлээгдэж буй төлөвт буцааж, дараагийн хуваарьт
                                ажлаар автоматаар боловсруулахыг баталгаажуулж байна.
                              </label>
                              <button type="submit" disabled={submission.pending}>
                                {submission.pending ? "Дараалалд оруулж байна..." : "Дахин дараалалд оруулах"}
                              </button>
                            </form>
                          </Show>
                        </section>
                      </>
                    )
                  }}
                </Show>
              </main>
            </>
          )}
        </Show>
      </ErrorBoundary>
    </>
  )
}

function DetailItem(props: { label: string; value: string | null; code?: boolean }) {
  return (
    <article data-component="recovery-detail-item">
      <span>{props.label}</span>
      <Show when={props.value} fallback={<strong>-</strong>}>
        {(value) => (props.code ? <code>{value()}</code> : <strong>{value()}</strong>)}
      </Show>
    </article>
  )
}

function formatDate(value: string | null) {
  if (!value) return "-"
  return new Intl.DateTimeFormat("mn-MN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Ulaanbaatar",
  }).format(new Date(value))
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("mn-MN").format(value)
}

function providerLabel(provider: string | null) {
  if (provider === "qpay") return "QPay"
  if (provider === "bonum") return "Bonum"
  return "-"
}

function RecoveryError() {
  return (
    <main data-page="admin-billing">
      <section data-component="empty" role="alert">
        Төлбөрийн сэргээх бүртгэлийг ачаалж чадсангүй. Хуудасны холбоосыг шалгаад дахин оролдоно уу.
        <br />
        <A href="/billing">Санхүүгийн хяналт руу буцах</A>
      </section>
    </main>
  )
}
