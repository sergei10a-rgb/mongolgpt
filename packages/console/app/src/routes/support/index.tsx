import "../index.css"
import { Meta, Title } from "@solidjs/meta"
import { A, useNavigate } from "@solidjs/router"
import { For, Show, createSignal, onMount } from "solid-js"
import { Footer } from "~/component/footer"
import { Header } from "~/component/header"
import { Legal } from "~/component/legal"
import { LocaleLinks } from "~/component/locale-links"
import { useLanguage } from "~/context/language"
import {
  type SupportCategory,
  type SupportTicketPage,
  SupportRequestError,
  createTicket,
  listTickets,
} from "./support-client"
import "./support.css"

const categories: { value: SupportCategory; label: string }[] = [
  { value: "account", label: "Бүртгэл" },
  { value: "billing", label: "Төлбөр" },
  { value: "technical", label: "Техникийн асуудал" },
  { value: "feedback", label: "Санал хүсэлт" },
  { value: "other", label: "Бусад" },
]

export default function SupportIndex() {
  const navigate = useNavigate()
  const language = useLanguage()
  const [page, setPage] = createSignal<SupportTicketPage>()
  const [authenticated, setAuthenticated] = createSignal(false)
  const [loading, setLoading] = createSignal(true)
  const [listError, setListError] = createSignal<string>()
  const [createError, setCreateError] = createSignal<string>()
  const [submitting, setSubmitting] = createSignal(false)
  const [subject, setSubject] = createSignal("")
  const [category, setCategory] = createSignal<SupportCategory>("technical")
  const [workspaceID, setWorkspaceID] = createSignal("")
  const [message, setMessage] = createSignal("")
  const [cursors, setCursors] = createSignal<(string | undefined)[]>([undefined])
  const [pageIndex, setPageIndex] = createSignal(0)

  async function load(cursor?: string) {
    setLoading(true)
    setListError(undefined)
    try {
      setPage(await listTickets(cursor))
      setAuthenticated(true)
    } catch (caught) {
      if (caught instanceof SupportRequestError && caught.status === 401) {
        setAuthenticated(false)
        return
      }
      setAuthenticated(false)
      setListError(messageFor(caught))
    } finally {
      setLoading(false)
    }
  }

  onMount(() => void load())

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    if (!subject().trim() || !message().trim()) {
      setCreateError("Гарчиг болон зурвасаа оруулна уу.")
      return
    }
    setSubmitting(true)
    setCreateError(undefined)
    try {
      const created = await createTicket({
        subject: subject().trim(),
        category: category(),
        workspaceID: workspaceID().trim() || undefined,
        message: message().trim(),
      })
      void navigate(language.route(`/support/${created.id}`))
    } catch (caught) {
      if (caught instanceof SupportRequestError && caught.status === 401) {
        setAuthenticated(false)
        return
      }
      setCreateError(messageFor(caught))
    } finally {
      setSubmitting(false)
    }
  }

  function next() {
    const cursor = page()?.nextCursor
    if (!cursor) return
    const nextCursors = [...cursors().slice(0, pageIndex() + 1), cursor]
    void (async () => {
      setLoading(true)
      setListError(undefined)
      try {
        const nextPage = await listTickets(cursor)
        if (nextPage.items.length === 0) {
          setPage((current) => (current ? { ...current, nextCursor: undefined } : current))
          return
        }
        setCursors(nextCursors)
        setPageIndex(nextCursors.length - 1)
        setPage(nextPage)
      } catch (caught) {
        setListError(messageFor(caught))
      } finally {
        setLoading(false)
      }
    })()
  }

  function previous() {
    const index = pageIndex() - 1
    if (index < 0) return
    setPageIndex(index)
    void load(cursors()[index])
  }

  return (
    <main data-page="mongolgpt" data-view="support">
      <Title>Тусламж | MongolGPT</Title>
      <Meta
        name="description"
        content="MongolGPT-ийн суулгалт, нэвтрэлт, үнэгүй автомат горим, загварын холболт, төлбөрийн тусламж"
      />
      <LocaleLinks path="/support" />
      <div data-component="container">
        <Header hideGetStarted />
        <div data-page="support">
          <header data-slot="page-header">
            <div>
              <p data-slot="eyebrow">MongolGPT</p>
              <h1>Тусламж</h1>
              <p>Заавраас хариултаа олох эсвэл бүртгэлээрээ нэвтэрч тусламжийн хүсэлт илгээнэ.</p>
            </div>
          </header>

          <section aria-labelledby="support-guides-title">
            <h2 id="support-guides-title">Түгээмэл хэрэгцээ</h2>
            <div data-slot="guide-links">
              <A href={language.route("/docs/install/")}>Суулгаж эхлэх</A>
              <A href={language.route("/docs/providers/")}>Загвар, API холбох</A>
              <A href={language.route("/docs/troubleshooting/")}>Алдаа оношлох</A>
              <A href={language.route("/pricing")}>Үнэ, багц шалгах</A>
            </div>
          </section>

          <Show when={!authenticated()}>
            <section aria-labelledby="support-login-title" data-section="support-login">
              <h2 id="support-login-title">Хувийн тусламжийн хүсэлт</h2>
              <p>
                Өөрийн хүсэлт, хариу болон төлөвийг аюулгүй харахын тулд MongolGPT бүртгэлээрээ нэвтрэх эсвэл шинэ
                бүртгэл үүсгэнэ үү.
              </p>
              <A href={language.route("/auth")} data-slot="primary-action">
                Нэвтэрч эсвэл бүртгүүлээд хүсэлт илгээх
              </A>
              <Show when={listError()}>
                {(value) => (
                  <p data-slot="notice" data-slot-error="true" role="alert">
                    {value()}
                  </p>
                )}
              </Show>
            </section>
          </Show>

          <Show when={authenticated()}>
            <section aria-labelledby="support-create-title">
              <h2 id="support-create-title">Шинэ хүсэлт</h2>
              <form onSubmit={submit} novalidate>
                <label>
                  Гарчиг
                  <input value={subject()} maxlength="160" onInput={(event) => setSubject(event.currentTarget.value)} />
                </label>
                <div data-slot="form-grid">
                  <label>
                    Ангилал
                    <select
                      value={category()}
                      onChange={(event) => setCategory(event.currentTarget.value as SupportCategory)}
                    >
                      <For each={categories}>{(item) => <option value={item.value}>{item.label}</option>}</For>
                    </select>
                  </label>
                  <label>
                    Ажлын орон зайн ID (заавал биш)
                    <input
                      value={workspaceID()}
                      maxlength="30"
                      onInput={(event) => setWorkspaceID(event.currentTarget.value)}
                    />
                  </label>
                </div>
                <label>
                  Зурвас
                  <textarea
                    value={message()}
                    maxlength="5000"
                    onInput={(event) => setMessage(event.currentTarget.value)}
                  />
                </label>
                <button type="submit" disabled={submitting()}>
                  {submitting() ? "Илгээж байна..." : "Хүсэлт илгээх"}
                </button>
              </form>
              <Show when={createError()}>
                {(value) => (
                  <p data-slot="notice" data-slot-error="true" role="alert">
                    {value()}
                  </p>
                )}
              </Show>
            </section>

            <section aria-labelledby="support-list-title">
              <h2 id="support-list-title">Миний хүсэлтүүд</h2>
              <Show when={listError()}>
                {(value) => (
                  <p data-slot="notice" data-slot-error="true" role="alert">
                    {value()}
                  </p>
                )}
              </Show>
              <Show when={loading()}>
                <p data-slot="notice" role="status">
                  Хүсэлтүүдийг ачаалж байна...
                </p>
              </Show>
              <Show when={!loading() && page()?.items.length === 0}>
                <p data-slot="notice">Одоогоор тусламжийн хүсэлт алга.</p>
              </Show>
              <Show when={!loading() && page()?.items.length}>
                <table data-slot="tickets">
                  <thead>
                    <tr>
                      <th>Гарчиг</th>
                      <th>Төлөв</th>
                      <th>Ангилал</th>
                      <th>Шинэчлэгдсэн</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={page()?.items}>
                      {(ticket) => (
                        <tr>
                          <td>
                            <A href={language.route(`/support/${ticket.id}`)}>{ticket.subject}</A>
                          </td>
                          <td>
                            <span data-slot="status">{statusName(ticket.status)}</span>
                          </td>
                          <td>{categoryName(ticket.category)}</td>
                          <td>
                            <time datetime={ticket.last_message_at}>{formatDate(ticket.last_message_at)}</time>
                          </td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </Show>
              <Show when={!loading() && (pageIndex() > 0 || page()?.nextCursor)}>
                <div data-slot="pagination">
                  <button type="button" onClick={previous} disabled={pageIndex() === 0}>
                    Өмнөх
                  </button>
                  <button type="button" onClick={next} disabled={!page()?.nextCursor}>
                    Дараах
                  </button>
                </div>
              </Show>
            </section>
          </Show>
        </div>
        <Footer />
      </div>
      <Legal />
    </main>
  )
}

export function statusName(status: string) {
  return (
    {
      open: "Нээлттэй",
      pending_user: "Таны хариуг хүлээж байна",
      pending_support: "Тусламжийн баг хянаж байна",
      resolved: "Шийдсэн",
      closed: "Хаасан",
    }[status] ?? status
  )
}

export function categoryName(category: SupportCategory) {
  return categories.find((item) => item.value === category)?.label ?? category
}

export function formatDate(value: string) {
  return new Intl.DateTimeFormat("mn-MN", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value))
}

function messageFor(error: unknown) {
  return error instanceof SupportRequestError
    ? error.message
    : "Тусламжийн мэдээллийг ачаалж чадсангүй. Дахин оролдоно уу."
}
