import "../index.css"
import { Title } from "@solidjs/meta"
import { A, useParams } from "@solidjs/router"
import { For, Show, createSignal, onMount } from "solid-js"
import { Footer } from "~/component/footer"
import { Header } from "~/component/header"
import { Legal } from "~/component/legal"
import { useLanguage } from "~/context/language"
import { SupportRequestError, type SupportTicketDetail, getTicket, replyToTicket } from "./support-client"
import { categoryName, formatDate, statusName } from "./index"
import "./support.css"

export default function SupportTicket() {
  const params = useParams()
  const language = useLanguage()
  const [detail, setDetail] = createSignal<SupportTicketDetail>()
  const [loading, setLoading] = createSignal(true)
  const [error, setError] = createSignal<string>()
  const [reply, setReply] = createSignal("")
  const [sending, setSending] = createSignal(false)
  const active = () => detail()?.ticket.status !== "resolved" && detail()?.ticket.status !== "closed"

  async function load() {
    setLoading(true)
    setError(undefined)
    try {
      const ticketID = params.ticketID
      if (!ticketID) {
        setError("Тусламжийн хүсэлтийн дугаар буруу байна.")
        return
      }
      setDetail(await getTicket(ticketID))
    } catch (caught) {
      setError(messageFor(caught))
    } finally {
      setLoading(false)
    }
  }

  onMount(() => void load())

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    const ticket = detail()?.ticket
    if (!ticket || !reply().trim()) {
      setError("Хариу зурвасаа оруулна уу.")
      return
    }
    setSending(true)
    setError(undefined)
    try {
      await replyToTicket(ticket.id, reply().trim(), ticket.lock_version)
      setReply("")
      await load()
    } catch (caught) {
      setError(messageFor(caught))
    } finally {
      setSending(false)
    }
  }

  return (
    <main data-page="mongolgpt" data-view="support-ticket">
      <Title>{detail()?.ticket.subject ? `${detail()?.ticket.subject} | MongolGPT` : "Тусламж | MongolGPT"}</Title>
      <div data-component="container">
        <Header hideGetStarted />
        <div data-page="support">
          <header data-slot="page-header">
            <A href={language.route("/support")}>Тусламж</A>
          </header>
          <Show when={loading()}>
            <p data-slot="notice" role="status">
              Хүсэлтийг ачаалж байна...
            </p>
          </Show>
          <Show when={error()}>
            {(value) => (
              <p data-slot="notice" data-slot-error="true" role="alert">
                {value()}
              </p>
            )}
          </Show>
          <Show when={!loading() && detail()}>
            {(data) => (
              <>
                <section aria-labelledby="ticket-subject">
                  <h1 id="ticket-subject">{data().ticket.subject}</h1>
                  <div data-slot="ticket-meta">
                    <span>{statusName(data().ticket.status)}</span>
                    <span>{categoryName(data().ticket.category)}</span>
                    <time datetime={data().ticket.time_created}>Үүссэн: {formatDate(data().ticket.time_created)}</time>
                    <time datetime={data().ticket.time_updated}>
                      Шинэчлэгдсэн: {formatDate(data().ticket.time_updated)}
                    </time>
                  </div>
                </section>
                <section aria-labelledby="ticket-messages-title">
                  <h2 id="ticket-messages-title">Зурвасууд</h2>
                  <div data-slot="messages">
                    <For each={data().messages}>
                      {(message) => (
                        <article data-slot="message" data-author={message.author_type}>
                          <div data-slot="message-header">
                            <strong>
                              {message.author_type === "customer" ? "Таны зурвас" : "MongolGPT тусламжийн хариу"}
                            </strong>
                            <time datetime={message.time_created}>{formatDate(message.time_created)}</time>
                          </div>
                          <p data-slot="message-body">{message.body}</p>
                        </article>
                      )}
                    </For>
                  </div>
                </section>
                <section aria-labelledby="ticket-reply-title">
                  <Show
                    when={active()}
                    fallback={
                      <p data-slot="notice">
                        Энэ хүсэлт {data().ticket.status === "resolved" ? "шийдэгдсэн" : "хаагдсан"} тул хариу нэмэх
                        боломжгүй.
                      </p>
                    }
                  >
                    <h2 id="ticket-reply-title">Хариу нэмэх</h2>
                    <form onSubmit={submit} novalidate>
                      <label>
                        Зурвас
                        <textarea
                          value={reply()}
                          maxlength="5000"
                          onInput={(event) => setReply(event.currentTarget.value)}
                        />
                      </label>
                      <button type="submit" disabled={sending()}>
                        {sending() ? "Илгээж байна..." : "Хариу илгээх"}
                      </button>
                    </form>
                  </Show>
                </section>
              </>
            )}
          </Show>
        </div>
        <Footer />
      </div>
      <Legal />
    </main>
  )
}

function messageFor(error: unknown) {
  return error instanceof SupportRequestError ? error.message : "Хүсэлтийг ачаалж чадсангүй. Дахин оролдоно уу."
}
