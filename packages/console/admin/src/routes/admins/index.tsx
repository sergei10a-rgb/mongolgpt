import { Title } from "@solidjs/meta"
import { action, createAsync, json, query, useSubmission } from "@solidjs/router"
import { getRequestEvent } from "solid-js/web"
import { For, Show } from "solid-js"
import { AdminHeader, roleLabel } from "~/component/admin-header"
import { getPlatformAdminContext } from "~/lib/admin-context"
import { listAdminOperators, mutateAdminOperator } from "~/lib/admin-operators"

export const adminOperatorsQuery = query(
  async () => {
    "use server"
    return listAdminOperators(getPlatformAdminContext())
  },
  "admin.operators.list",
)

export const mutateAdminOperatorAction = action(async (form: FormData) => {
  "use server"
  const event = getRequestEvent()
  if (!event) throw new Error("Админы хүсэлтийн орчин олдсонгүй.")
  return json(await mutateAdminOperator(getPlatformAdminContext(), event.request, Object.fromEntries(form.entries())), {
    revalidate: adminOperatorsQuery.key,
  })
}, "admin.operators.mutate")

export default function AdminOperatorsPage() {
  const operators = createAsync(() => adminOperatorsQuery())
  const submission = useSubmission(mutateAdminOperatorAction)

  return (
    <>
      <Title>Операторын удирдлага | MongolGPT</Title>
      <Show
        when={operators()}
        fallback={
          <main data-page="admin-operators">
            <section data-component="loading" aria-live="polite">
              Операторын мэдээллийг ачаалж байна...
            </section>
          </main>
        }
      >
        {(data) => (
          <>
            <AdminHeader admin={data().admin} active="admins" />
            <main data-page="admin-operators">
              <section data-component="page-heading">
                <div>
                  <p data-component="eyebrow">Платформын хяналтын эрх</p>
                  <h1>Операторын удирдлага</h1>
                </div>
                <span data-component="read-only">Зөвхөн эзэмшигч удирдана</span>
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

              <section data-component="operator-create" aria-labelledby="operator-create-title">
                <div data-component="section-heading">
                  <div>
                    <p data-component="eyebrow">Шинэ оператор</p>
                    <h2 id="operator-create-title">Идэвхтэй эрх нэмэх</h2>
                  </div>
                </div>
                <form action={mutateAdminOperatorAction} method="post" aria-label="Шинэ оператор нэмэх">
                  <input type="hidden" name="operation" value="create" />
                  <label>
                    <span>Имэйл</span>
                    <input name="email" type="email" autocomplete="email" maxlength="254" required placeholder="operator@company.mn" />
                  </label>
                  <label>
                    <span>Эрх</span>
                    <select name="role" required>
                      <RoleOptions />
                    </select>
                  </label>
                  <button type="submit" disabled={submission.pending}>
                    {submission.pending ? "Нэмж байна..." : "Оператор нэмэх"}
                  </button>
                </form>
              </section>

              <section data-component="operator-directory" aria-labelledby="operator-directory-title">
                <div data-component="section-heading">
                  <div>
                    <p data-component="eyebrow">Cloudflare Access ба дотоод эрх</p>
                    <h2 id="operator-directory-title">Операторууд</h2>
                  </div>
                  <span>{data().operators.length} бүртгэл</span>
                </div>
                <div data-component="table-scroll">
                  <table data-table="operators">
                    <thead>
                      <tr>
                        <th>Имэйл</th>
                        <th>Эрх</th>
                        <th>Төлөв</th>
                        <th>Cloudflare хандалт</th>
                        <th>Сүүлд нэвтэрсэн</th>
                        <th>Үүссэн</th>
                        <th>Үйлдэл</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For
                        each={data().operators}
                        fallback={
                          <tr>
                            <td colspan="7" data-empty>
                              Операторын бүртгэл алга.
                            </td>
                          </tr>
                        }
                      >
                        {(operator) => (
                          <tr data-status={operator.status}>
                            <td data-account>
                              <strong>{operator.email}</strong>
                              <code>{operator.id}</code>
                            </td>
                            <td>{roleLabel(operator.role)}</td>
                            <td>
                              <span data-account-status={operator.status}>{statusLabel(operator.status)}</span>
                            </td>
                            <td>
                              <span data-account-status={operator.accessAllowed ? "active" : "suspended"}>
                                {operator.accessAllowed ? "Зөвшөөрсөн" : "Жагсаалтад алга"}
                              </span>
                            </td>
                            <td>{formatDate(operator.timeLastSeen)}</td>
                            <td>{formatDate(operator.timeCreated)}</td>
                            <td data-action-cell>
                              <Show when={operator.mutable} fallback={<span data-component="self-account">Хамгаалагдсан эрх</span>}>
                                <details data-component="operator-action">
                                  <summary>Удирдах</summary>
                                  <div>
                                    <form action={mutateAdminOperatorAction} method="post">
                                      <input type="hidden" name="operation" value="update_role" />
                                      <input type="hidden" name="operatorID" value={operator.id} />
                                      <label for={`role-${operator.id}`}>Эрх</label>
                                      <select id={`role-${operator.id}`} name="role" value={operator.role} required>
                                        <RoleOptions />
                                      </select>
                                      <button type="submit" disabled={submission.pending}>
                                        {submission.pending ? "Хадгалж байна..." : "Эрх хадгалах"}
                                      </button>
                                    </form>
                                    <form action={mutateAdminOperatorAction} method="post">
                                      <input type="hidden" name="operation" value={operator.status === "active" ? "suspend" : "reactivate"} />
                                      <input type="hidden" name="operatorID" value={operator.id} />
                                      <button type="submit" data-variant={operator.status === "active" ? "danger" : "primary"} disabled={submission.pending}>
                                        {submission.pending
                                          ? "Хадгалж байна..."
                                          : operator.status === "active"
                                            ? "Түр түдгэлзүүлэх"
                                            : "Дахин идэвхжүүлэх"}
                                      </button>
                                    </form>
                                  </div>
                                </details>
                              </Show>
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
        )}
      </Show>
    </>
  )
}

function RoleOptions() {
  return (
    <>
      <option value="administrator">Ерөнхий админ</option>
      <option value="support">Хэрэглэгчийн тусламж</option>
      <option value="finance">Санхүү</option>
      <option value="operations">Системийн ажиллагаа</option>
    </>
  )
}

function statusLabel(status: string) {
  return status === "suspended" ? "Түдгэлзсэн" : "Идэвхтэй"
}

function formatDate(value: string | null) {
  if (!value) return "-"
  return new Intl.DateTimeFormat("mn-MN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Ulaanbaatar",
  }).format(new Date(value))
}
