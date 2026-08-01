import { createEffect, createMemo, createResource, createSignal, Show } from "solid-js"
import { useI18n } from "~/context/i18n"
import styles from "./account-deletion-section.module.css"

type DeletionStatus = "requested" | "processing" | "completed" | "failed" | "cancelled"

type Deletion = {
  status: DeletionStatus
  eligibleAt?: number
}

type AccountDeletionView = {
  email: string
  deletion: Deletion | null
}

export function AccountDeletionSection() {
  const i18n = useI18n()
  const [view] = createResource(load)
  const [current, setCurrent] = createSignal<Deletion>()
  const [email, setEmail] = createSignal("")
  const [confirmation, setConfirmation] = createSignal("")
  const [busy, setBusy] = createSignal<"request" | "cancel">()
  const [error, setError] = createSignal("")
  const deletion = createMemo(() => current() ?? view()?.deletion ?? null)

  createEffect(() => {
    const value = view()?.email
    if (value && !email()) setEmail(value)
  })

  async function requestDeletion(event: SubmitEvent) {
    event.preventDefault()
    setBusy("request")
    setError("")
    try {
      const next = await mutate("POST", {
        email: email(),
        confirmation: confirmation(),
      })
      setCurrent(next)
      setConfirmation("")
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy()
    }
  }

  async function cancelDeletion() {
    setBusy("cancel")
    setError("")
    try {
      setCurrent(await mutate("DELETE", { confirmation: "ЦУЦЛАХ" }))
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy()
    }
  }

  return (
    <section class={styles.root}>
      <div data-slot="section-title">
        <h2>{i18n.t("account.deletion.title")}</h2>
        <p>{i18n.t("account.deletion.subtitle")}</p>
      </div>
      <div data-slot="section-content">
        <p data-slot="warning">{i18n.t("account.deletion.warning")}</p>
        <Show when={!view.loading} fallback={<div data-slot="loading" aria-hidden="true" />}>
          <Show when={!view.error} fallback={<p data-slot="error">{i18n.t("account.deletion.loadError")}</p>}>
            <Show when={deletion()} keyed>
              {(value) => (
                <DeletionState
                  deletion={value}
                  busy={busy()}
                  onCancel={cancelDeletion}
                  scheduled={(date) => i18n.t("account.deletion.scheduled", { date })}
                  retrying={i18n.t("account.deletion.retrying")}
                  processing={i18n.t("account.deletion.processing")}
                  cancelled={i18n.t("account.deletion.cancelled")}
                  cancel={i18n.t("account.deletion.cancel")}
                  cancelling={i18n.t("account.deletion.cancelling")}
                />
              )}
            </Show>
            <Show when={!deletion() || deletion()?.status === "cancelled"}>
              <form onSubmit={requestDeletion}>
                <label>
                  <span>{i18n.t("account.deletion.email")}</span>
                  <input
                    required
                    type="email"
                    autocomplete="email"
                    value={email()}
                    onInput={(event) => setEmail(event.currentTarget.value)}
                  />
                </label>
                <label>
                  <span>{i18n.t("account.deletion.confirmation")}</span>
                  <input
                    required
                    type="text"
                    autocomplete="off"
                    value={confirmation()}
                    onInput={(event) => setConfirmation(event.currentTarget.value)}
                  />
                </label>
                <button type="submit" data-color="danger" disabled={Boolean(busy())}>
                  {busy() === "request" ? i18n.t("account.deletion.requesting") : i18n.t("account.deletion.request")}
                </button>
              </form>
            </Show>
          </Show>
        </Show>
        <Show when={error()}>{(value) => <p data-slot="error">{value()}</p>}</Show>
      </div>
    </section>
  )
}

function DeletionState(props: {
  deletion: Deletion
  busy?: "request" | "cancel"
  onCancel: () => void
  scheduled: (date: string) => string
  retrying: string
  processing: string
  cancelled: string
  cancel: string
  cancelling: string
}) {
  if (props.deletion.status === "cancelled") return <p data-slot="status">{props.cancelled}</p>
  if (props.deletion.status === "processing" || props.deletion.status === "completed") {
    return <p data-slot="status">{props.processing}</p>
  }

  const date = props.deletion.eligibleAt
    ? new Intl.DateTimeFormat("mn-MN", { dateStyle: "long", timeStyle: "short" }).format(props.deletion.eligibleAt)
    : "-"
  return (
    <div data-slot="scheduled">
      <p data-slot="status">{props.deletion.status === "failed" ? props.retrying : props.scheduled(date)}</p>
      <button type="button" data-color="ghost" disabled={Boolean(props.busy)} onClick={props.onCancel}>
        {props.busy === "cancel" ? props.cancelling : props.cancel}
      </button>
    </div>
  )
}

async function load(): Promise<AccountDeletionView> {
  const response = await fetch("/api/account-deletion", {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  })
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) throw new Error(serverError(body))
  if (!record(body) || !record(body.account) || typeof body.account.email !== "string") {
    throw new Error("invalid_account_deletion_response")
  }
  return {
    email: body.account.email,
    deletion: parseDeletion(body.deletion),
  }
}

async function mutate(method: "POST" | "DELETE", input: Record<string, string>) {
  const response = await fetch("/api/account-deletion", {
    method,
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  })
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) throw new Error(serverError(body))
  if (!record(body)) throw new Error("invalid_account_deletion_response")
  const deletion = parseDeletion(body.deletion)
  if (!deletion) throw new Error("invalid_account_deletion_response")
  return deletion
}

function parseDeletion(value: unknown): Deletion | null {
  if (value === null || value === undefined) return null
  if (!record(value) || !status(value.status)) throw new Error("invalid_account_deletion_response")
  const eligibleAt =
    typeof value.eligibleAt === "number" && Number.isSafeInteger(value.eligibleAt) ? value.eligibleAt : undefined
  return { status: value.status, eligibleAt }
}

function status(value: unknown): value is DeletionStatus {
  return (
    value === "requested" ||
    value === "processing" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  )
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function serverError(value: unknown) {
  return record(value) && typeof value.error === "string" ? value.error : "server_error"
}

function message(cause: unknown) {
  return cause instanceof Error && !cause.message.startsWith("invalid_") && cause.message !== "server_error"
    ? cause.message
    : "Хүсэлтийг боловсруулахад алдаа гарлаа."
}
