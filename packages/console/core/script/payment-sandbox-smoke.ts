import { BonumAdapter } from "../src/payment-provider/bonum"
import { QPayAdapter } from "../src/payment-provider/qpay"
import type {
  PaymentCancellationAdapter,
  PaymentInvoiceCheckout,
  PaymentProviderAdapter,
  PaymentReconciliationAdapter,
  VerifiedPaymentEvent,
} from "../src/payment-provider"

const CONFIRMATION = "RUN_SANDBOX_SMOKE"
const PROVIDERS = ["qpay", "bonum", "all"] as const
const MAX_REFERENCE_LENGTH = 24
const INVOICE_AMOUNT_MNT = 1
const BONUM_EXPIRY_MS = 5 * 60 * 1_000
const DEFAULT_TIMEOUT_MS = 30_000

type Provider = (typeof PROVIDERS)[number]
type QPaySmokeAdapter = Pick<
  PaymentProviderAdapter & PaymentReconciliationAdapter & PaymentCancellationAdapter,
  "createInvoice" | "reconcileInvoice" | "cancelInvoice"
>
type BonumSmokeAdapter = Pick<PaymentProviderAdapter, "createInvoice">
type OperatorOutput = (message: string) => void

export type PaymentSandboxSmokeInput = {
  confirmation?: string
  environment?: string
  provider?: string
  callbackBaseURL?: string
  reference?: string
  qpay?: QPaySmokeAdapter
  bonum?: BonumSmokeAdapter
  now?: () => number
  timeoutMs?: number
  output?: OperatorOutput
}

export type PaymentSandboxSmokeResult = {
  qpay?: { externalInvoiceID: string; cancelled: true }
  bonum?: { externalInvoiceID: string; checkoutURL: string; expiresAt: number }
}

export async function runPaymentSandboxSmoke(input: PaymentSandboxSmokeInput): Promise<PaymentSandboxSmokeResult> {
  const provider = parseProvider(input.provider)
  assertSandbox(input)
  const now = input.now ?? Date.now
  parseCallbackBaseURL(input.callbackBaseURL)
  const reference = parseReference(input.reference, now())
  const timeoutMs = parseTimeout(input.timeoutMs)
  const output = input.output ?? console.log
  const result: PaymentSandboxSmokeResult = {}

  if (provider === "qpay" || provider === "all") {
    if (!input.qpay) throw new Error("QPay sandbox adapter тохируулагдаагүй байна")
    output("QPay sandbox: 1 MNT нэхэмжлэх үүсгэж, pending төлвийг шалгаж байна.")
    result.qpay = await withTimeout(runQPay(input.qpay, reference, now), timeoutMs)
    output("QPay sandbox: нэхэмжлэхийг цуцалж дууслаа.")
  }

  if (provider === "bonum" || provider === "all") {
    if (!input.bonum) throw new Error("Bonum sandbox adapter тохируулагдаагүй байна")
    const expiresAt = now() + BONUM_EXPIRY_MS
    output("Bonum sandbox: богино хугацаатай 1 MNT checkout үүсгэж байна.")
    result.bonum = await withTimeout(runBonum(input.bonum, reference, expiresAt), timeoutMs)
    output("Bonum sandbox: checkout холбоос баталгаажлаа.")
  }

  return result
}

async function runQPay(adapter: QPaySmokeAdapter, reference: string, now: () => number) {
  let checkout: PaymentInvoiceCheckout | undefined
  try {
    checkout = await adapter.createInvoice({
      reference: `${reference}-qpay`,
      customerReference: "sandbox-smoke",
      description: "MongolGPT sandbox smoke",
      amount: INVOICE_AMOUNT_MNT,
      currency: "MNT",
      expiresAt: now() + BONUM_EXPIRY_MS,
    })
    if (checkout.provider !== "qpay") throw new Error("QPay sandbox буруу нийлүүлэгчийн нэхэмжлэх буцаалаа")
    const events = await adapter.reconcileInvoice({
      externalInvoiceID: checkout.externalInvoiceID,
      expectedAmount: INVOICE_AMOUNT_MNT,
      currency: "MNT",
    })
    assertPendingQPay(events, checkout.externalInvoiceID)
    return { externalInvoiceID: checkout.externalInvoiceID, cancelled: true as const }
  } finally {
    if (checkout) await adapter.cancelInvoice({ externalInvoiceID: checkout.externalInvoiceID })
  }
}

async function runBonum(adapter: BonumSmokeAdapter, reference: string, expiresAt: number) {
  const checkout = await adapter.createInvoice({
    reference: `${reference}-bonum`,
    customerReference: "sandbox-smoke",
    description: "MongolGPT sandbox smoke",
    amount: INVOICE_AMOUNT_MNT,
    currency: "MNT",
    expiresAt,
  })
  if (checkout.provider !== "bonum") throw new Error("Bonum sandbox буруу нийлүүлэгчийн нэхэмжлэх буцаалаа")
  const checkoutURL = assertBonumCheckout(checkout)
  return { externalInvoiceID: checkout.externalInvoiceID, checkoutURL, expiresAt }
}

function assertPendingQPay(events: VerifiedPaymentEvent[], externalInvoiceID: string) {
  if (events.length !== 1 || events[0]?.type !== "pending" || events[0].externalInvoiceID !== externalInvoiceID) {
    throw new Error("QPay sandbox нэхэмжлэх pending төлөвтэй баталгаажаагүй байна")
  }
}

function assertBonumCheckout(checkout: PaymentInvoiceCheckout) {
  if (!checkout.checkoutURL) throw new Error("Bonum sandbox checkout холбоос буцаагаагүй байна")
  let url: URL
  try {
    url = new URL(checkout.checkoutURL)
  } catch {
    throw new Error("Bonum sandbox хүчинтэй checkout холбоос буцаагаагүй байна")
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "ecommerce.bonum.mn" ||
    url.pathname !== "/ecommerce" ||
    url.searchParams.get("invoiceId") !== checkout.externalInvoiceID
  ) {
    throw new Error("Bonum sandbox аюулгүй checkout холбоос буцаагаагүй байна")
  }
  return url.href
}

function assertSandbox(input: PaymentSandboxSmokeInput) {
  if (input.confirmation !== CONFIRMATION) {
    throw new Error(
      `Сүлжээний үйлдэл хийхийн тулд MONGOLGPT_PAYMENT_SANDBOX_SMOKE_CONFIRM=${CONFIRMATION} гэж зөвшөөрнө үү`,
    )
  }
  if (input.environment !== "sandbox") {
    throw new Error("Зөвхөн sandbox орчинд ажиллана. Production төлбөрийн орчин хатуу хориглогдсон.")
  }
}

function parseProvider(value: string | undefined): Provider {
  const provider = value ?? "all"
  if ((PROVIDERS as readonly string[]).includes(provider)) return provider as Provider
  throw new Error("MONGOLGPT_PAYMENT_SANDBOX_PROVIDER нь qpay, bonum, эсвэл all байна")
}

function parseCallbackBaseURL(value: string | undefined) {
  if (!value) throw new Error("MONGOLGPT_PAYMENT_SANDBOX_CALLBACK_BASE_URL шаардлагатай")
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("Sandbox callback base URL хүчинтэй URL байх ёстой")
  }
  const host = url.hostname.toLowerCase()
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !["pay.dev.mgpt.mn", "pay.staging.mgpt.mn", "pay.sandbox.mgpt.mn"].includes(host)
  ) {
    throw new Error(
      "Sandbox callback base URL нь HTTPS pay.dev.mgpt.mn, pay.staging.mgpt.mn эсвэл pay.sandbox.mgpt.mn байна",
    )
  }
  return url.origin
}

function parseReference(value: string | undefined, now: number) {
  const reference = value ?? `mgpt-${Math.max(0, Math.floor(now)).toString(36)}`
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(reference) || reference.length > MAX_REFERENCE_LENGTH) {
    throw new Error(`Sandbox reference нь ${MAX_REFERENCE_LENGTH} хүртэлх латин үсэг, тоо, _ эсвэл - байна`)
  }
  return reference
}

function parseTimeout(value: number | undefined) {
  const timeoutMs = value ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) {
    throw new Error("Sandbox timeout 1000-60000 миллисекунд байна")
  }
  return timeoutMs
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Sandbox smoke хугацаа хэтэрлээ")), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function redactSecrets(message: string, secrets: Iterable<string>) {
  let redacted = message
  for (const secret of secrets) {
    if (secret) redacted = redacted.replaceAll(secret, "[НУУЦ]")
  }
  return redacted
}

function environment() {
  return {
    confirmation: process.env.MONGOLGPT_PAYMENT_SANDBOX_SMOKE_CONFIRM,
    environment: process.env.MONGOLGPT_PAYMENT_SANDBOX_ENVIRONMENT,
    provider: process.env.MONGOLGPT_PAYMENT_SANDBOX_PROVIDER,
    callbackBaseURL: process.env.MONGOLGPT_PAYMENT_SANDBOX_CALLBACK_BASE_URL,
    reference: process.env.MONGOLGPT_PAYMENT_SANDBOX_REFERENCE,
  }
}

function nativeAdapters(provider: Provider, callbackBaseURL: string) {
  const timeoutMs = 8_000
  return {
    qpay:
      provider === "qpay" || provider === "all"
        ? new QPayAdapter({
            environment: "sandbox",
            merchantAccountID: process.env.QPAY_MERCHANT_ACCOUNT_ID ?? "",
            clientID: process.env.QPAY_CLIENT_ID ?? "",
            clientSecret: process.env.QPAY_CLIENT_SECRET ?? "",
            invoiceCode: process.env.QPAY_INVOICE_CODE ?? "",
            invoiceCallbackURL: `${callbackBaseURL}/v1/webhooks/qpay`,
            timeoutMs,
          })
        : undefined,
    bonum:
      provider === "bonum" || provider === "all"
        ? new BonumAdapter({
            environment: "sandbox",
            merchantAccountID: process.env.BONUM_MERCHANT_ACCOUNT_ID ?? "",
            appSecret: process.env.BONUM_APP_SECRET ?? "",
            terminalID: process.env.BONUM_TERMINAL_ID ?? "",
            webhookChecksumKey: process.env.BONUM_WEBHOOK_CHECKSUM_KEY ?? "",
            invoiceCallbackURL: `${callbackBaseURL}/v1/webhooks/bonum`,
            maxExpirySeconds: Math.ceil(BONUM_EXPIRY_MS / 1_000),
            timeoutMs,
          })
        : undefined,
  }
}

if (import.meta.main) {
  const config = environment()
  const secrets = [
    process.env.QPAY_MERCHANT_ACCOUNT_ID ?? "",
    process.env.QPAY_CLIENT_ID ?? "",
    process.env.QPAY_CLIENT_SECRET ?? "",
    process.env.QPAY_INVOICE_CODE ?? "",
    process.env.BONUM_MERCHANT_ACCOUNT_ID ?? "",
    process.env.BONUM_APP_SECRET ?? "",
    process.env.BONUM_TERMINAL_ID ?? "",
    process.env.BONUM_WEBHOOK_CHECKSUM_KEY ?? "",
  ]
  try {
    const provider = parseProvider(config.provider)
    assertSandbox(config)
    const callbackBaseURL = parseCallbackBaseURL(config.callbackBaseURL)
    parseReference(config.reference, Date.now())
    const adapters = nativeAdapters(provider, callbackBaseURL)
    await runPaymentSandboxSmoke({ ...config, ...adapters })
    console.log("Payment sandbox smoke амжилттай дууслаа.")
  } catch (error) {
    const message = error instanceof Error ? error.message : "Тодорхойгүй алдаа"
    console.error(`Payment sandbox smoke амжилтгүй: ${redactSecrets(message, secrets)}`)
    process.exitCode = 1
  }
}
