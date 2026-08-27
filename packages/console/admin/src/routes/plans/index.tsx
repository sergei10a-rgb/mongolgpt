import { Title } from "@solidjs/meta"
import { action, createAsync, json, query, useSubmission } from "@solidjs/router"
import { getRequestEvent } from "solid-js/web"
import { For, Show } from "solid-js"
import { AdminHeader } from "~/component/admin-header"
import { getPlatformAdminContext } from "~/lib/admin-context"
import { listAdminPlans, mutateAdminPlans } from "~/lib/admin-plans"

export const adminPlansQuery = query(async () => {
  "use server"
  return listAdminPlans(getPlatformAdminContext())
}, "admin.plans.list")

export const mutateAdminPlansAction = action(async (form: FormData) => {
  "use server"
  const event = getRequestEvent()
  if (!event) throw new Error("Админы хүсэлтийн орчин олдсонгүй.")
  return json(await mutateAdminPlans(getPlatformAdminContext(), event.request, Object.fromEntries(form.entries())), {
    revalidate: adminPlansQuery.key,
  })
}, "admin.plans.mutate")

const fields = [
  ["weeklyCostLimit", "7 хоногийн зардлын дээд хэмжээ (ам.доллар)"],
  ["weeklyTokenLimit", "7 хоногийн токен дээд хэмжээ"],
  ["weeklyRequestLimit", "7 хоногийн хүсэлтийн дээд хэмжээ"],
  ["monthlyCostLimit", "Сарын зардлын дээд хэмжээ (ам.доллар)"],
  ["monthlyTokenLimit", "Сарын токен дээд хэмжээ"],
  ["monthlyRequestLimit", "Сарын хүсэлтийн дээд хэмжээ"],
  ["rollingCostLimit", "Гулсах цонхны зардлын дээд хэмжээ (ам.доллар)"],
  ["rollingWindow", "Гулсах цонхны хугацаа (цаг)"],
] as const

export default function AdminPlansPage() {
  const plans = createAsync(() => adminPlansQuery())
  const submission = useSubmission(mutateAdminPlansAction)
  return (
    <>
      <Title>Төлөвлөгөөний удирдлага | MongolGPT</Title>
      <Show when={plans()} fallback={<Loading />}>
        {(data) => {
          const limits = data().active.limits
          return (
            <>
              <AdminHeader admin={data().admin} active="plans" />
              <main data-page="admin-plans">
                <section data-component="page-heading">
                  <div>
                    <p data-component="eyebrow">D1 өгөгдлийн сан дахь хувилбарлагдсан хэрэглээний хязгаар</p>
                    <h1>Төлөвлөгөөний удирдлага</h1>
                  </div>
                  <span data-component="read-only">
                    {data().active.source === "d1"
                      ? `Идэвхтэй хувилбар ${data().active.revision}`
                      : "Анхны нууц тохиргоо"}
                  </span>
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

                <section data-component="plan-state" aria-labelledby="plan-state-title">
                  <div>
                    <p data-component="eyebrow">Одоогийн эх сурвалж</p>
                    <h2 id="plan-state-title">
                      {data().active.source === "d1" ? "D1 өгөгдлийн санд хадгалсан хувилбар" : "Анхны нууц тохиргоо"}
                    </h2>
                  </div>
                  <dl>
                    <div>
                      <dt>Хувилбар</dt>
                      <dd>{data().active.versionID ?? "Идэвхжүүлээгүй"}</dd>
                    </div>
                    <div>
                      <dt>Хувилбарын дугаар</dt>
                      <dd>{data().active.revision}</dd>
                    </div>
                    <div>
                      <dt>Идэвхжүүлэлтийн дугаар</dt>
                      <dd>{data().active.stateRevision ?? "Байхгүй"}</dd>
                    </div>
                    <Show when={data().active.note}>
                      <div>
                        <dt>Тайлбар</dt>
                        <dd>{data().active.note}</dd>
                      </div>
                    </Show>
                  </dl>
                </section>

                <form
                  action={mutateAdminPlansAction}
                  method="post"
                  data-component="plan-form"
                  aria-label="Төлөвлөгөөний хэрэглээний хязгаар шинэчлэх"
                >
                  <input type="hidden" name="operation" value="update" />
                  <input type="hidden" name="expectedRevision" value={data().latestRevision} />
                  <input
                    type="hidden"
                    name="expectedActiveStateRevision"
                    value={data().active.stateRevision ?? "none"}
                  />
                  <fieldset>
                    <legend>Үнэгүй</legend>
                    <p>Үнэ төлбөргүй хэрэглэгчийн өдөр тутмын суурь хязгаар.</p>
                    <div data-component="plan-field-grid">
                      <NumberField
                        name="free.promoTokens"
                        label="Урамшууллын токен"
                        value={limits.free.promoTokens}
                        min="0"
                      />
                      <NumberField name="free.dailyRequests" label="Өдрийн хүсэлт" value={limits.free.dailyRequests} />
                      <NumberField
                        name="free.dailyRequestsFallback"
                        label="Нөөц өдрийн хүсэлт"
                        value={limits.free.dailyRequestsFallback}
                      />
                    </div>
                  </fieldset>
                  <TierFields title="Үндсэн (Basic)" prefix="basic" values={limits.plans.basic} />
                  <TierFields title="Про (Pro)" prefix="pro" values={limits.plans.pro} />
                  <TierFields title="Дээд (Max)" prefix="max" values={limits.plans.max} />
                  <label data-component="plan-note">
                    <span>Монгол тайлбар</span>
                    <textarea
                      name="note"
                      required
                      minlength="5"
                      maxlength="500"
                      rows="3"
                      placeholder="Өөрчлөлтийн шалтгааныг Монгол хэлээр тодорхой бичнэ үү"
                    />
                  </label>
                  <div data-component="plan-submit">
                    <p>Өөрчлөлт нь буцааж засах боломжгүй шинэ хувилбар үүсгэж, үйлдлийн бүртгэлтэйгээр идэвхжинэ.</p>
                    <button type="submit" disabled={submission.pending}>
                      {submission.pending ? "Хадгалж байна..." : "Шинэ хувилбар идэвхжүүлэх"}
                    </button>
                  </div>
                </form>

                <section data-component="plan-history" aria-labelledby="plan-history-title">
                  <div data-component="section-heading">
                    <div>
                      <p data-component="eyebrow">Сүүлийн 20 буцааж засах боломжгүй хувилбар</p>
                      <h2 id="plan-history-title">Хувилбарын түүх</h2>
                    </div>
                  </div>
                  <div data-component="table-scroll">
                    <table data-table="plans">
                      <thead>
                        <tr>
                          <th>Хувилбарын дугаар</th>
                          <th>Хувилбар</th>
                          <th>Эх сурвалж</th>
                          <th>Тайлбар</th>
                          <th>Үүссэн</th>
                          <th>Үйлдэл</th>
                        </tr>
                      </thead>
                      <tbody>
                        <For
                          each={data().versions}
                          fallback={
                            <tr>
                              <td colspan="6" data-empty>
                                Хадгалсан хувилбар одоогоор алга.
                              </td>
                            </tr>
                          }
                        >
                          {(version) => (
                            <tr data-active={version.active ? "true" : undefined}>
                              <td>{version.revision}</td>
                              <td>
                                <code>{version.id}</code>
                              </td>
                              <td>{version.sourceVersionID ? <code>{version.sourceVersionID}</code> : "Шинэчлэлт"}</td>
                              <td>{version.note ?? "-"}</td>
                              <td>{formatDate(version.timeCreated)}</td>
                              <td>
                                {version.active ? (
                                  <span data-component="self-account">Идэвхтэй</span>
                                ) : (
                                  <details data-component="plan-rollback">
                                    <summary>Буцаах</summary>
                                    <form action={mutateAdminPlansAction} method="post">
                                      <input type="hidden" name="operation" value="rollback" />
                                      <input type="hidden" name="sourceVersionID" value={version.id} />
                                      <input type="hidden" name="expectedRevision" value={data().latestRevision} />
                                      <input
                                        type="hidden"
                                        name="expectedActiveStateRevision"
                                        value={data().active.stateRevision ?? "none"}
                                      />
                                      <label for={`confirmation-${version.id}`}>Баталгаажуулалт</label>
                                      <input
                                        id={`confirmation-${version.id}`}
                                        name="confirmation"
                                        required
                                        placeholder="БУЦААХ"
                                        aria-describedby={`confirm-help-${version.id}`}
                                      />
                                      <small id={`confirm-help-${version.id}`}>
                                        Буцаахын тулд БУЦААХ гэж яг бичнэ үү.
                                      </small>
                                      <label for={`note-${version.id}`}>Монгол тайлбар</label>
                                      <textarea
                                        id={`note-${version.id}`}
                                        name="note"
                                        required
                                        minlength="5"
                                        maxlength="500"
                                        rows="3"
                                        placeholder="Буцаалтын шалтгаан"
                                      />
                                      <button type="submit" disabled={submission.pending}>
                                        {submission.pending ? "Хадгалж байна..." : "Буцаалтыг идэвхжүүлэх"}
                                      </button>
                                    </form>
                                  </details>
                                )}
                              </td>
                            </tr>
                          )}
                        </For>
                      </tbody>
                    </table>
                  </div>
                </section>
              </main>
            </>
          )
        }}
      </Show>
    </>
  )
}

function TierFields(props: {
  title: string
  prefix: "basic" | "pro" | "max"
  values: Record<(typeof fields)[number][0], number>
}) {
  return (
    <fieldset>
      <legend>{props.title}</legend>
      <p>Долоо хоног, сар, гулсах цонхны төлбөртэй хэрэглэгчийн хэрэглээний хязгаар.</p>
      <div data-component="plan-field-grid">
        <For each={fields}>
          {([field, label]) => (
            <NumberField
              name={`${props.prefix}.${field}`}
              label={label}
              value={props.values[field]}
              max={field === "rollingWindow" ? "168" : undefined}
            />
          )}
        </For>
      </div>
    </fieldset>
  )
}

function NumberField(props: { name: string; label: string; value: number; min?: string; max?: string }) {
  return (
    <label>
      <span>{props.label}</span>
      <input
        name={props.name}
        type="number"
        inputmode="numeric"
        value={props.value}
        min={props.min ?? "1"}
        max={props.max}
        step="1"
        required
      />
    </label>
  )
}

function Loading() {
  return (
    <main data-page="admin-plans">
      <section data-component="loading" aria-live="polite">
        Төлөвлөгөөний тохиргоог ачаалж байна...
      </section>
    </main>
  )
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("mn-MN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Ulaanbaatar",
  }).format(new Date(value))
}
