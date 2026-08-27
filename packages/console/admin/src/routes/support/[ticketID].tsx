import { Title } from "@solidjs/meta"
import { A, createAsync, query, useParams, useSubmission } from "@solidjs/router"
import { ErrorBoundary, For, Show } from "solid-js"
import { AdminHeader } from "~/component/admin-header"
import { getPlatformAdminContext } from "~/lib/admin-context"
import { getAdminSupportTicketDetail, listAssignableSupportAdmins } from "~/lib/admin-support"
import {
  adminSupportQueryKey,
  categoryLabel,
  formatDate,
  mutateAdminSupportAction,
  priorityLabel,
  PriorityOptions,
  statusLabel,
  StatusOptions,
} from "./index"

export const adminSupportTicketQuery = query(async (ticketID: string) => {
  "use server"
  const context = getPlatformAdminContext()
  const [detail, assignableAdmins] = await Promise.all([
    getAdminSupportTicketDetail(context, ticketID),
    listAssignableSupportAdmins(context),
  ])
  return {
    admin: context,
    canManage: context.permissions.includes("support.manage"),
    assignableAdmins,
    ...detail,
  }
}, adminSupportQueryKey)

export default function AdminSupportTicketPage() {
  const params = useParams()
  const ticket = createAsync(() => adminSupportTicketQuery(params.ticketID ?? ""))
  const submission = useSubmission(mutateAdminSupportAction)
  return (
    <>
      <Title>Тусламжийн хүсэлтийн дэлгэрэнгүй | MongolGPT</Title>
      <ErrorBoundary fallback={<TicketError />}>
        <Show
          when={ticket()}
          fallback={
            <main data-page="admin-support">
              <section data-component="loading" aria-live="polite">
                Тусламжийн хүсэлтийг ачаалж байна...
              </section>
            </main>
          }
        >
          {(data) => {
            const current = data().ticket
            return (
              <>
                <AdminHeader admin={data().admin} active="support" />
                <main data-page="admin-support">
                  <section data-component="page-heading">
                    <div>
                      <p data-component="eyebrow">
                        <A href="/support">Тусламжийн хүсэлт</A> / {current.id}
                      </p>
                      <h1>{current.subject}</h1>
                    </div>
                    <span data-component="read-only">{data().canManage ? "Удирдах эрхтэй" : "Зөвхөн харах горим"}</span>
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

                  <section data-component="support-detail" aria-labelledby="ticket-information-title">
                    <div data-component="section-heading">
                      <div>
                        <h2 id="ticket-information-title">Дэлгэрэнгүй</h2>
                      </div>
                    </div>
                    <dl>
                      <div>
                        <dt>Аккаунт</dt>
                        <dd>
                          <code>{current.account_id}</code>
                        </dd>
                      </div>
                      <div>
                        <dt>Холбоо барих имэйл</dt>
                        <dd>{current.requester_email}</dd>
                      </div>
                      <div>
                        <dt>Ажлын орон зай</dt>
                        <dd>{current.workspace_id ? <code>{current.workspace_id}</code> : "Холбоогүй"}</dd>
                      </div>
                      <div>
                        <dt>Ангилал</dt>
                        <dd>{categoryLabel(current.category)}</dd>
                      </div>
                      <div>
                        <dt>Төлөв</dt>
                        <dd>{statusLabel(current.status)}</dd>
                      </div>
                      <div>
                        <dt>Тэргүүлэх зэрэг</dt>
                        <dd>{priorityLabel(current.priority)}</dd>
                      </div>
                      <div>
                        <dt>Хариуцсан админ</dt>
                        <dd>{assignedLabel(current.assigned_admin_id, data().assignableAdmins)}</dd>
                      </div>
                      <div>
                        <dt>Үүссэн</dt>
                        <dd>{formatDate(current.time_created)}</dd>
                      </div>
                      <div>
                        <dt>Сүүлд идэвхтэй</dt>
                        <dd>{formatDate(current.last_message_at)}</dd>
                      </div>
                      <div>
                        <dt>Шийдсэн</dt>
                        <dd>{formatDate(current.time_resolved)}</dd>
                      </div>
                      <div>
                        <dt>Хаасан</dt>
                        <dd>{formatDate(current.time_closed)}</dd>
                      </div>
                    </dl>
                  </section>

                  <section data-component="support-thread" aria-labelledby="support-thread-title">
                    <div data-component="section-heading">
                      <div>
                        <h2 id="support-thread-title">Зурвасууд</h2>
                      </div>
                    </div>
                    <ol>
                      <For each={data().messages}>
                        {(message) => (
                          <li data-support-message={message.internal ? "internal" : message.author_type}>
                            <div>
                              <strong>{messageLabel(message.author_type, message.internal)}</strong>
                              <time dateTime={new Date(message.time_created).toISOString()}>
                                {formatDate(message.time_created)}
                              </time>
                            </div>
                            <p>{message.body}</p>
                          </li>
                        )}
                      </For>
                    </ol>
                  </section>

                  <Show when={data().canManage}>
                    <section data-component="support-actions" aria-labelledby="support-actions-title">
                      <div data-component="section-heading">
                        <div>
                          <h2 id="support-actions-title">Удирдах</h2>
                        </div>
                      </div>
                      <form
                        action={mutateAdminSupportAction}
                        method="post"
                        aria-label="Хүсэлтийн төлөв, зэрэг, хариуцалтыг шинэчлэх"
                      >
                        <input type="hidden" name="operation" value="update" />
                        <input type="hidden" name="ticketID" value={current.id} />
                        <input type="hidden" name="expectedLockVersion" value={current.lock_version} />
                        <label>
                          <span>Төлөв</span>
                          <select name="status" value={current.status}>
                            <StatusOptions current={current.status} />
                          </select>
                        </label>
                        <label>
                          <span>Тэргүүлэх зэрэг</span>
                          <select name="priority" value={current.priority}>
                            <PriorityOptions />
                          </select>
                        </label>
                        <label>
                          <span>Хариуцсан админ</span>
                          <select name="assignedAdminID" value={current.assigned_admin_id ?? "__unassigned"}>
                            <option value="__unassigned">Оноогоогүй</option>
                            <For each={data().assignableAdmins}>
                              {(admin) => <option value={admin.id}>{admin.email}</option>}
                            </For>
                          </select>
                        </label>
                        <button type="submit" disabled={submission.pending}>
                          {submission.pending ? "Хадгалж байна..." : "Мэдээлэл хадгалах"}
                        </button>
                      </form>
                      <div data-component="support-composer-grid">
                        <Show when={current.status !== "resolved" && current.status !== "closed"}>
                          <form
                            action={mutateAdminSupportAction}
                            method="post"
                            data-visibility="public"
                            aria-label="Хэрэглэгчид харагдах хариу илгээх"
                          >
                            <input type="hidden" name="operation" value="reply" />
                            <input type="hidden" name="ticketID" value={current.id} />
                            <input type="hidden" name="expectedLockVersion" value={current.lock_version} />
                            <label>
                              <span>Хэрэглэгчид харагдах хариу</span>
                              <textarea
                                name="message"
                                required
                                maxlength="5000"
                                rows="5"
                                placeholder="Хэрэглэгчид илгээх Монгол хариу"
                              />
                            </label>
                            <button type="submit" disabled={submission.pending}>
                              {submission.pending ? "Илгээж байна..." : "Хариу илгээх"}
                            </button>
                          </form>
                        </Show>
                        <form
                          action={mutateAdminSupportAction}
                          method="post"
                          data-visibility="internal"
                          aria-label="Зөвхөн дотоод тэмдэглэл нэмэх"
                        >
                          <input type="hidden" name="operation" value="note" />
                          <input type="hidden" name="ticketID" value={current.id} />
                          <input type="hidden" name="expectedLockVersion" value={current.lock_version} />
                          <label>
                            <span>Дотоод тэмдэглэл</span>
                            <textarea
                              name="message"
                              required
                              maxlength="5000"
                              rows="5"
                              placeholder="Хэрэглэгчид харагдахгүй дотоод тэмдэглэл"
                            />
                          </label>
                          <p>Энэ тэмдэглэл хэрэглэгчид огт харагдахгүй.</p>
                          <button type="submit" disabled={submission.pending}>
                            {submission.pending ? "Хадгалж байна..." : "Дотоод тэмдэглэл хадгалах"}
                          </button>
                        </form>
                      </div>
                    </section>
                  </Show>
                </main>
              </>
            )
          }}
        </Show>
      </ErrorBoundary>
    </>
  )
}

function assignedLabel(id: string | null, admins: { id: string; email: string }[]) {
  return !id ? "Оноогоогүй" : (admins.find((admin) => admin.id === id)?.email ?? id)
}
function messageLabel(authorType: string, internal: boolean) {
  if (internal) return "Дотоод тэмдэглэл (хэрэглэгчид харагдахгүй)"
  return authorType === "customer" ? "Хэрэглэгчийн зурвас" : "Админы хариу (хэрэглэгчид харагдана)"
}
function TicketError() {
  return (
    <main data-page="admin-support">
      <section data-component="empty" role="alert">
        Энэ тусламжийн хүсэлтийг ачаалж чадсангүй. Хуудасны холбоосыг шалгаад дахин оролдоно уу.
      </section>
    </main>
  )
}
