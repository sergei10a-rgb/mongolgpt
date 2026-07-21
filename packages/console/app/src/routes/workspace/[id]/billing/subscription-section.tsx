import { Actor } from "@mongolgpt/console-core/actor.js"
import {
  getSubscriptionBillingOverview,
  PaymentPlanCatalogSchema,
  SubscriptionCheckoutRequestSchema,
  type SubscriptionBillingOverview,
  type SubscriptionCheckoutResult,
} from "@mongolgpt/console-core/payment-checkout.js"
import {
  SubscriptionCheckoutCancellationRequestSchema,
  type PaymentCancellationState,
} from "@mongolgpt/console-core/payment-cancellation-contract.js"
import { Resource } from "@mongolgpt/console-resource"
import { action, createAsync, json, query, useAction, useParams, useSubmission } from "@solidjs/router"
import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js"
import { withActor } from "~/context/auth.withActor"
import { safeHttpsHref, safePaymentDeepLink, safeQrImage } from "~/lib/payment-display"
import { PaymentServiceClientError } from "~/lib/payment-service"
import { requestSubscriptionCheckout, requestSubscriptionCheckoutCancellation } from "~/lib/payment-service.server"
import styles from "./subscription-section.module.css"

const planOrder = ["basic", "pro", "max"] as const
const providerNames = { qpay: "QPay", bonum: "Bonum" } as const
const providerOptions = [
  { value: "qpay", label: providerNames.qpay },
  { value: "bonum", label: providerNames.bonum },
] as const
const openStatuses = new Set(["creating", "unknown", "ready", "pending"])

export const querySubscriptionBilling = query(async (workspaceID: string) => {
  "use server"
  return withActor(async () => {
    Actor.assertAdmin()
    const config = Resource.PaymentConfig
    const catalog = (() => {
      try {
        return PaymentPlanCatalogSchema.safeParse(JSON.parse(config.planCatalog))
      } catch {
        return { success: false as const }
      }
    })()
    return {
      enabled: config.enabled === true && catalog.success,
      environment: config.environment === "production" ? ("production" as const) : ("sandbox" as const),
      catalog: catalog.success ? catalog.data : null,
      overview: await getSubscriptionBillingOverview(Actor.workspace()),
    }
  }, workspaceID)
}, "subscription.billing.get")

export const createPlanCheckout = action(async (workspaceID: string, plan: string, provider: string, key: string) => {
  "use server"
  return json(
    await withActor(async () => {
      Actor.assertAdmin()
      const actor = Actor.assert("user")
      const input = SubscriptionCheckoutRequestSchema.safeParse({
        workspaceID: Actor.workspace(),
        accountID: actor.properties.accountID,
        requestKey: key,
        provider,
        plan,
      })
      if (!input.success) return { ok: false as const, error: "Төлбөрийн сонголт буруу байна." }
      try {
        return { ok: true as const, data: await requestSubscriptionCheckout(input.data) }
      } catch (error) {
        if (error instanceof PaymentServiceClientError) {
          return {
            ok: false as const,
            error: error.message,
            code: error.code,
            invoiceID: error.invoiceID,
          }
        }
        console.error("Subscription checkout action failed", {
          workspaceID: Actor.workspace(),
          error: error instanceof Error ? error.name : typeof error,
        })
        return { ok: false as const, error: "Нэхэмжлэх үүсгэх үед алдаа гарлаа." }
      }
    }, workspaceID),
    { revalidate: querySubscriptionBilling.key },
  )
}, "subscription.billing.create")

export const cancelPlanCheckout = action(async (workspaceID: string, invoiceID: string, key: string) => {
  "use server"
  return json(
    await withActor(async () => {
      Actor.assertAdmin()
      const actor = Actor.assert("user")
      const input = SubscriptionCheckoutCancellationRequestSchema.safeParse({
        workspaceID: Actor.workspace(),
        accountID: actor.properties.accountID,
        invoiceID,
        requestKey: key,
      })
      if (!input.success) return { ok: false as const, error: "Цуцлах хүсэлт буруу байна." }
      try {
        return { ok: true as const, data: await requestSubscriptionCheckoutCancellation(input.data) }
      } catch (error) {
        if (error instanceof PaymentServiceClientError) {
          return { ok: false as const, error: error.message, code: error.code }
        }
        console.error("Subscription checkout cancellation action failed", {
          workspaceID: Actor.workspace(),
          error: error instanceof Error ? error.name : typeof error,
        })
        return { ok: false as const, error: "Нэхэмжлэх цуцлах үед алдаа гарлаа." }
      }
    }, workspaceID),
    { revalidate: querySubscriptionBilling.key },
  )
}, "subscription.billing.cancel")

export function SubscriptionSection() {
  const params = useParams()
  const billing = createAsync(() => querySubscriptionBilling(params.id!))
  const createCheckout = useAction(createPlanCheckout)
  const submission = useSubmission(createPlanCheckout)
  const cancelCheckout = useAction(cancelPlanCheckout)
  const cancellationSubmission = useSubmission(cancelPlanCheckout)
  const [plan, setPlan] = createSignal<(typeof planOrder)[number]>("pro")
  const [provider, setProvider] = createSignal<keyof typeof providerNames>("qpay")
  const [requestKey, setRequestKey] = createSignal("")
  const [cancellationRequest, setCancellationRequest] = createSignal<{ invoiceID: string; key: string }>()
  const [copied, setCopied] = createSignal(false)

  const overview = createMemo(() => billing()?.overview)
  const actionCheckout = createMemo(() => {
    const result = submission.result
    return result?.ok ? result.data : undefined
  })
  const checkout = createMemo(() => {
    const persisted = overview()?.checkout
    const created = actionCheckout()
    if (!created) return persisted ?? null
    if (persisted?.invoiceID === created.invoiceID) return persisted
    return created
  })
  const active = createMemo(() => overview()?.subscription ?? null)
  const canCreate = createMemo(() => {
    const current = checkout()
    return !active() && (!current || !openStatuses.has(current.status))
  })

  async function onCreate() {
    setCancellationRequest(undefined)
    cancellationSubmission.clear()
    let key = requestKey()
    if (!key) {
      key = crypto.randomUUID()
      setRequestKey(key)
    }
    await createCheckout(params.id!, plan(), provider(), key)
  }

  async function onCancel(invoiceID: string) {
    let request = cancellationRequest()
    if (!request || request.invoiceID !== invoiceID) {
      request = { invoiceID, key: crypto.randomUUID() }
      setCancellationRequest(request)
    }
    await cancelCheckout(params.id!, invoiceID, request.key)
    submission.clear()
  }

  function selectPlan(value: (typeof planOrder)[number]) {
    setPlan(value)
    if (!submission.pending) {
      setRequestKey("")
      submission.clear()
    }
  }

  function selectProvider(value: keyof typeof providerNames) {
    setProvider(value)
    if (!submission.pending) {
      setRequestKey("")
      submission.clear()
    }
  }

  async function copyQr(value: string) {
    await navigator.clipboard.writeText(value)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1_500)
  }

  return (
    <section class={styles.root}>
      <div data-slot="section-title">
        <h2>Багц ба төлбөр</h2>
        <p>Төлбөр баталгаажмагц сонгосон багц энэ ажлын талбарт автоматаар идэвхжинэ.</p>
      </div>
      <div data-slot="section-content">
        <Show when={billing()} fallback={<p data-slot="muted">Төлбөрийн мэдээллийг ачаалж байна...</p>}>
          {(state) => (
            <Switch>
              <Match when={active()}>
                {(subscription) => (
                  <div data-slot="active-plan">
                    <div>
                      <span data-slot="eyebrow">Идэвхтэй багц</span>
                      <strong>{planName(subscription().plan)}</strong>
                    </div>
                    <div data-slot="plan-period">
                      <span>Дуусах огноо</span>
                      <time datetime={new Date(subscription().periodEnd).toISOString()}>
                        {formatDate(subscription().periodEnd)}
                      </time>
                    </div>
                  </div>
                )}
              </Match>
              <Match when={!state().enabled || !state().catalog}>
                <div data-slot="notice" data-tone="neutral">
                  <strong>Туршилтын төлбөрийн орчин тохируулагдаагүй байна</strong>
                  <span>
                    QPay эсвэл Bonum-ын туршилтын байгууллагын эрх холбогдсоны дараа эндээс нэхэмжлэх үүсгэнэ.
                  </span>
                </div>
              </Match>
              <Match when={state().catalog}>
                {(catalog) => (
                  <>
                    <div data-slot="plans" aria-label="Багц сонгох">
                      <For each={planOrder}>
                        {(item) => (
                          <button
                            type="button"
                            data-slot="plan"
                            data-selected={plan() === item ? "true" : undefined}
                            aria-pressed={plan() === item}
                            disabled={!canCreate() || submission.pending}
                            onClick={() => selectPlan(item)}
                          >
                            <span>{planName(item)}</span>
                            <strong>{formatMnt(catalog()[item].amount)}</strong>
                            <small>/ сар</small>
                          </button>
                        )}
                      </For>
                    </div>
                    <Show when={canCreate()}>
                      <div data-slot="checkout-controls">
                        <div data-slot="provider-group" role="group" aria-label="Төлбөрийн суваг">
                          <For each={providerOptions}>
                            {(option) => (
                              <button
                                type="button"
                                data-selected={provider() === option.value ? "true" : undefined}
                                aria-pressed={provider() === option.value}
                                disabled={submission.pending}
                                onClick={() => selectProvider(option.value)}
                              >
                                {option.label}
                              </button>
                            )}
                          </For>
                        </div>
                        <button data-color="primary" type="button" disabled={submission.pending} onClick={onCreate}>
                          {submission.pending ? "Нэхэмжлэх үүсгэж байна..." : "Нэхэмжлэх үүсгэх"}
                        </button>
                        <span data-slot="environment">
                          {state().environment === "sandbox" ? "Туршилтын орчин" : "Үйлдвэрлэлийн орчин"}
                        </span>
                      </div>
                    </Show>
                  </>
                )}
              </Match>
            </Switch>
          )}
        </Show>

        <Show when={submission.result?.ok === false ? submission.result : undefined}>
          {(result) => (
            <div data-slot="notice" data-tone={result().code === "request_in_progress" ? "neutral" : "danger"}>
              <strong>Нэхэмжлэх үүссэнгүй</strong>
              <span>{result().error}</span>
            </div>
          )}
        </Show>

        <Show when={cancellationSubmission.result?.ok === false ? cancellationSubmission.result : undefined}>
          {(result) => (
            <div data-slot="notice" data-tone={result().code === "request_in_progress" ? "neutral" : "danger"}>
              <strong>Нэхэмжлэх цуцлагдсангүй</strong>
              <span>{result().error}</span>
            </div>
          )}
        </Show>

        <Show when={!active() && checkout()}>
          {(invoice) => (
            <CheckoutDetails
              invoice={invoice()}
              copied={copied()}
              cancellationPending={Boolean(cancellationSubmission.pending)}
              onCopy={(value) => copyQr(value)}
              onCancel={() => onCancel(invoice().invoiceID)}
            />
          )}
        </Show>
      </div>
    </section>
  )
}

function CheckoutDetails(props: {
  invoice: SubscriptionBillingOverview["checkout"] | SubscriptionCheckoutResult
  copied: boolean
  cancellationPending: boolean
  onCopy(value: string): void
  onCancel(): void
}) {
  const [confirmCancellation, setConfirmCancellation] = createSignal(false)
  const invoice = () => props.invoice!
  const details = () => invoice().checkout
  const qrImage = () => safeQrImage(details()?.qrImage)
  const checkoutURL = () => safeHttpsHref(details()?.checkoutURL)
  const bankLinks = () =>
    details()?.deepLinks.flatMap((link) => {
      const href = safePaymentDeepLink(link.link)
      return href ? [{ ...link, href }] : []
    }) ?? []
  const cancellation = (): PaymentCancellationState | null => {
    const current = invoice()
    if (current.status === "paid" || current.status === "refunded") return null
    return "cancellation" in current ? current.cancellation : null
  }
  const effectiveStatus = () => {
    if (cancellation()?.status === "cancelled") return "cancelled"
    const status = invoice().status
    return (status === "ready" || status === "pending") && invoice().expiresAt <= Date.now() ? "expired" : status
  }
  const cancellationBlocksPayment = () => {
    const status = cancellation()?.status
    return status === "requested" || status === "unknown" || status === "cancelled"
  }
  const payable = () =>
    !cancellationBlocksPayment() && (effectiveStatus() === "ready" || effectiveStatus() === "pending")
  const statusLabel = () => {
    if (cancellation()?.status === "requested") return "Цуцалж байна"
    if (cancellation()?.status === "unknown") return "Цуцлалт тодорхойгүй"
    return statusName(effectiveStatus())
  }

  return (
    <div data-slot="invoice" data-status={effectiveStatus()}>
      <div data-slot="invoice-header">
        <div>
          <span data-slot="eyebrow">{providerNames[invoice().provider]} нэхэмжлэх</span>
          <strong>{formatMnt(invoice().amount)}</strong>
        </div>
        <span data-slot="status">{statusLabel()}</span>
      </div>
      <Show
        when={payable() && details()}
        fallback={
          <div
            data-slot="notice"
            data-tone={cancellation()?.status === "unknown" || effectiveStatus() === "unknown" ? "danger" : "neutral"}
          >
            <strong>{statusLabel()}</strong>
            <span>{cancellationDescription(cancellation()?.status) ?? statusDescription(effectiveStatus())}</span>
          </div>
        }
      >
        {(payment) => (
          <div data-slot="payment-body">
            <Show when={qrImage()}>
              {(source) => <img data-slot="qr" src={source()} alt="QPay төлбөрийн QR код" width="220" height="220" />}
            </Show>
            <div data-slot="payment-actions">
              <div data-slot="invoice-meta">
                <span>{planName(invoice().plan)}</span>
                <span>Хүчинтэй хугацаа: {formatDate(invoice().expiresAt)}</span>
                <code>{invoice().invoiceID}</code>
              </div>
              <Show when={checkoutURL()}>
                {(url) => (
                  <a data-component="button" data-color="primary" href={url()} target="_blank" rel="noreferrer">
                    Төлбөрийн хуудас нээх
                  </a>
                )}
              </Show>
              <Show when={bankLinks().length > 0}>
                <div data-slot="bank-links">
                  <For each={bankLinks()}>
                    {(link) => (
                      <a data-component="button" href={link.href} target="_blank" rel="noreferrer">
                        {link.name}
                      </a>
                    )}
                  </For>
                </div>
              </Show>
              <Show when={payment().qrText}>
                {(value) => (
                  <button type="button" data-color="ghost" onClick={() => props.onCopy(value())}>
                    {props.copied ? "QR утгыг хууллаа" : "QR утгыг хуулах"}
                  </button>
                )}
              </Show>
              <Show when={invoice().provider === "qpay" && !cancellation()}>
                <Show
                  when={confirmCancellation()}
                  fallback={
                    <button type="button" data-color="ghost" onClick={() => setConfirmCancellation(true)}>
                      Нэхэмжлэх цуцлах
                    </button>
                  }
                >
                  <div data-slot="cancel-confirmation">
                    <span>Энэ QPay нэхэмжлэхийг цуцлах уу?</span>
                    <div>
                      <button type="button" data-color="ghost" onClick={() => setConfirmCancellation(false)}>
                        Үгүй
                      </button>
                      <button type="button" disabled={props.cancellationPending} onClick={() => props.onCancel()}>
                        {props.cancellationPending ? "Цуцалж байна..." : "Тийм, цуцлах"}
                      </button>
                    </div>
                  </div>
                </Show>
              </Show>
              <Show when={invoice().provider === "bonum"}>
                <small data-slot="provider-note">
                  Bonum нэхэмжлэх API-аар цуцлагддаггүй. Төлөхгүй бол хүчинтэй хугацаандаа автоматаар хаагдана.
                </small>
              </Show>
              <Show when={cancellation()?.status === "failed"}>
                <small data-slot="provider-note">
                  Өмнөх цуцлах хүсэлт амжилтгүй болсон. Энэ нэхэмжлэхээр төлөх боломжтой хэвээр байна.
                </small>
              </Show>
            </div>
          </div>
        )}
      </Show>
    </div>
  )
}

function planName(plan: "basic" | "pro" | "max") {
  return plan === "basic" ? "Basic" : plan === "pro" ? "Pro" : "Max"
}

function formatMnt(amount: number) {
  return new Intl.NumberFormat("mn-MN", { style: "currency", currency: "MNT", maximumFractionDigits: 0 }).format(amount)
}

function formatDate(timestamp: number) {
  return new Intl.DateTimeFormat("mn-MN", { dateStyle: "medium", timeStyle: "short" }).format(timestamp)
}

function statusName(status: NonNullable<SubscriptionBillingOverview["checkout"]>["status"]) {
  if (status === "creating") return "Үүсгэж байна"
  if (status === "unknown") return "Төлөв тодорхойгүй"
  if (status === "ready") return "Төлбөр хүлээж байна"
  if (status === "pending") return "Баталгаажуулж байна"
  if (status === "paid") return "Төлөгдсөн"
  if (status === "failed") return "Амжилтгүй"
  if (status === "expired") return "Хугацаа дууссан"
  if (status === "cancelled") return "Цуцлагдсан"
  return "Буцаан олгосон"
}

function statusDescription(status: NonNullable<SubscriptionBillingOverview["checkout"]>["status"]) {
  if (status === "unknown") return "Давтан төлөхөөс өмнө дэмжлэгтэй холбогдож төлвийг шалгуулна уу."
  if (status === "creating") return "Үйлчилгээ нэхэмжлэх үүсгэж байна. Түр хүлээнэ үү."
  if (status === "pending") return "Төлбөрийн байгууллагаас баталгаажуулж байна."
  if (status === "paid") return "Төлбөр баталгаажсан. Багцын эрх шинэчлэгдэж байна."
  if (status === "failed") return "Нэхэмжлэх үүсгэх эсвэл төлөх үйлдэл амжилтгүй боллоо."
  if (status === "expired") return "Энэ нэхэмжлэхээр төлбөр хийх боломжгүй."
  if (status === "cancelled") return "Энэ нэхэмжлэх цуцлагдсан."
  if (status === "refunded") return "Төлбөрийг буцаан олгосон."
  return "Төлбөрийн сувгаа сонгон төлнө үү."
}

function cancellationDescription(status: PaymentCancellationState["status"] | undefined) {
  if (status === "requested") return "QPay цуцлах хүсэлтийг боловсруулж байна. Энэ хооронд төлбөр бүү хийгээрэй."
  if (status === "unknown")
    return "Төлбөрийн үйлчилгээний хариу тодорхойгүй байна. Давтан цуцлахгүйгээр дэмжлэгтэй холбогдоно уу."
  if (status === "cancelled") return "Энэ нэхэмжлэх QPay дээр цуцлагдсан."
  if (status === "failed") return "Цуцлах хүсэлт амжилтгүй болсон. Нэхэмжлэх хүчинтэй хэвээр байна."
  return undefined
}
