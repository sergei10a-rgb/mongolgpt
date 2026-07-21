import { Resource } from "@mongolgpt/console-resource"
import { createPaymentQueueEvent, type PaymentQueueEvent } from "@mongolgpt/console-core/payment-queue.js"
import {
  PaymentInvoiceReferenceSchema,
  PaymentIngressNotFoundError,
  reconcileQPayCallback,
  verifyBonumWebhook,
} from "@mongolgpt/console-core/payment-ingress.js"
import { BonumAdapter, BonumWebhookVerificationError } from "@mongolgpt/console-core/payment-provider/bonum.js"
import { QPayAdapter } from "@mongolgpt/console-core/payment-provider/qpay.js"
import { PaymentProviderResponseError, type VerifiedPaymentEvent } from "@mongolgpt/console-core/payment-provider.js"
import {
  cancelSubscriptionCheckout,
  PaymentCancellationAuthorizationError,
  PaymentCancellationConflictError,
  PaymentCancellationOperationError,
  PaymentCancellationUnavailableError,
  PaymentCancellationUnsupportedError,
  SubscriptionCheckoutCancellationRequestSchema,
  SubscriptionCheckoutCancellationResultSchema,
  type SubscriptionCancellationOutcome,
  type SubscriptionCheckoutCancellationRequest,
} from "@mongolgpt/console-core/payment-cancellation.js"
import {
  createSubscriptionCheckout,
  PaymentCheckoutAuthorizationError,
  PaymentCheckoutConflictError,
  PaymentCheckoutCreationError,
  PaymentPlanCatalogSchema,
  SubscriptionCheckoutRequestSchema,
  SubscriptionCheckoutResultSchema,
  type SubscriptionCheckoutRequest,
  type SubscriptionCheckoutResult,
} from "@mongolgpt/console-core/payment-checkout.js"
import { z } from "zod"

const MAX_WEBHOOK_BYTES = 1_000_000

type Dependencies = {
  qpay?: (input: { reference: string; callbackPaymentID?: string }) => Promise<VerifiedPaymentEvent[]>
  bonum?: (input: { rawBody: string; checksum: string }) => Promise<VerifiedPaymentEvent[]>
  enqueue(events: PaymentQueueEvent[]): Promise<void>
  internalToken?: string
  createSubscriptionCheckout?: (input: SubscriptionCheckoutRequest) => Promise<SubscriptionCheckoutResult>
  cancelSubscriptionCheckout?: (
    input: SubscriptionCheckoutCancellationRequest,
  ) => Promise<SubscriptionCancellationOutcome>
}

class PaymentQueueUnavailableError extends Error {
  constructor() {
    super("Payment queue unavailable")
    this.name = "PaymentQueueUnavailableError"
  }
}

class InvalidPaymentWebhookRequestError extends Error {
  constructor() {
    super("Invalid payment webhook request")
    this.name = "InvalidPaymentWebhookRequestError"
  }
}

class InvalidPaymentCheckoutResponseError extends Error {
  constructor() {
    super("Invalid payment checkout response")
    this.name = "InvalidPaymentCheckoutResponseError"
  }
}

function text(body: string, status = 200, headers: HeadersInit = {}) {
  const responseHeaders = new Headers(headers)
  responseHeaders.set("Cache-Control", "no-store")
  responseHeaders.set("Content-Type", "text/plain; charset=utf-8")
  return new Response(body, {
    status,
    headers: responseHeaders,
  })
}

function json(body: unknown, status = 200, headers: HeadersInit = {}) {
  const responseHeaders = new Headers(headers)
  responseHeaders.set("Cache-Control", "no-store")
  return Response.json(body, { status, headers: responseHeaders })
}

function secretsEqual(actual: string, expected: string) {
  const encoder = new TextEncoder()
  const left = encoder.encode(actual)
  const right = encoder.encode(expected)
  let mismatch = left.length ^ right.length
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index++) mismatch |= (left[index] ?? 0) ^ (right[index] ?? 0)
  return mismatch === 0
}

function authorized(request: Request, token: string | undefined) {
  if (!token) return false
  return secretsEqual(request.headers.get("authorization") ?? "", `Bearer ${token}`)
}

async function enqueueVerifiedEvents(events: VerifiedPaymentEvent[], dependencies: Dependencies) {
  if (events.length < 1 || events.length > 2) throw new Error("Payment verifier returned an invalid event count")
  try {
    await dependencies.enqueue(events.map((event) => createPaymentQueueEvent(event)))
  } catch {
    throw new PaymentQueueUnavailableError()
  }
}

function uniqueQueryValue(url: URL, name: string, required: boolean) {
  const values = url.searchParams.getAll(name)
  if (values.length > 1 || (required && values.length !== 1)) throw new InvalidPaymentWebhookRequestError()
  const value = values[0]?.trim()
  if (required && !value) throw new InvalidPaymentWebhookRequestError()
  return value || undefined
}

async function readBoundedBody(request: Request) {
  const declared = request.headers.get("content-length")
  if (declared !== null) {
    const bytes = Number(declared)
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_WEBHOOK_BYTES) {
      await request.body?.cancel().catch(() => undefined)
      throw new RangeError("Webhook body is too large")
    }
  }
  if (!request.body) return ""

  const reader = request.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let body = ""
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > MAX_WEBHOOK_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new RangeError("Webhook body is too large")
      }
      body += decoder.decode(part.value, { stream: true })
    }
    return body + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

export function createPaymentWebhookHandler(dependencies: Dependencies) {
  return async function handle(request: Request) {
    const url = new URL(request.url)
    try {
      if (url.pathname === "/health") {
        return Response.json(
          {
            status: dependencies.qpay || dependencies.bonum ? "ok" : "disabled",
            service: "payments",
            providers: {
              qpay: Boolean(dependencies.qpay),
              bonum: Boolean(dependencies.bonum),
            },
            checkout: Boolean(dependencies.createSubscriptionCheckout),
            cancellation: Boolean(dependencies.cancelSubscriptionCheckout),
          },
          { headers: { "Cache-Control": "no-store" } },
        )
      }

      if (url.pathname === "/v1/checkouts/subscription") {
        if (!authorized(request, dependencies.internalToken)) {
          await request.body?.cancel().catch(() => undefined)
          return json({ error: "Дотоод төлбөрийн үйлчилгээний зөвшөөрөл хүчингүй байна." }, 401)
        }
        if (request.method !== "POST") {
          await request.body?.cancel().catch(() => undefined)
          return json({ error: "Зөвшөөрөгдөөгүй хүсэлт." }, 405, { Allow: "POST" })
        }
        if (!dependencies.createSubscriptionCheckout) {
          await request.body?.cancel().catch(() => undefined)
          return json({ error: "Төлбөрийн туршилтын орчин одоогоор тохируулагдаагүй байна." }, 503)
        }
        const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
        if (contentType !== "application/json") {
          await request.body?.cancel().catch(() => undefined)
          return json({ error: "Төлбөрийн хүсэлт JSON байх ёстой." }, 400)
        }
        let body: unknown
        try {
          body = JSON.parse(await readBoundedBody(request))
        } catch (error) {
          if (error instanceof RangeError) throw error
          return json({ error: "Төлбөрийн хүсэлтийн JSON буруу байна." }, 400)
        }
        const parsed = SubscriptionCheckoutRequestSchema.safeParse(body)
        if (!parsed.success) return json({ error: "Төлбөрийн хүсэлтийн бүтэц буруу байна." }, 400)
        const result = SubscriptionCheckoutResultSchema.safeParse(
          await dependencies.createSubscriptionCheckout(parsed.data),
        )
        if (!result.success) throw new InvalidPaymentCheckoutResponseError()
        return json(result.data, 201)
      }

      if (url.pathname === "/v1/checkouts/subscription/cancel") {
        if (!authorized(request, dependencies.internalToken)) {
          await request.body?.cancel().catch(() => undefined)
          return json({ error: "Дотоод төлбөрийн үйлчилгээний зөвшөөрөл хүчингүй байна." }, 401)
        }
        if (request.method !== "POST") {
          await request.body?.cancel().catch(() => undefined)
          return json({ error: "Зөвшөөрөгдөөгүй хүсэлт." }, 405, { Allow: "POST" })
        }
        if (!dependencies.cancelSubscriptionCheckout) {
          await request.body?.cancel().catch(() => undefined)
          return json({ error: "Төлбөрийн цуцлалтын үйлчилгээ одоогоор тохируулагдаагүй байна." }, 503)
        }
        const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
        if (contentType !== "application/json") {
          await request.body?.cancel().catch(() => undefined)
          return json({ error: "Цуцлах хүсэлт JSON байх ёстой." }, 400)
        }
        let body: unknown
        try {
          body = JSON.parse(await readBoundedBody(request))
        } catch (error) {
          if (error instanceof RangeError) throw error
          return json({ error: "Цуцлах хүсэлтийн JSON буруу байна." }, 400)
        }
        const parsed = SubscriptionCheckoutCancellationRequestSchema.safeParse(body)
        if (!parsed.success) return json({ error: "Цуцлах хүсэлтийн бүтэц буруу байна." }, 400)
        const outcome = await dependencies.cancelSubscriptionCheckout(parsed.data)
        const result = SubscriptionCheckoutCancellationResultSchema.safeParse(outcome.result)
        if (!result.success) throw new InvalidPaymentCheckoutResponseError()
        if (outcome.event) await enqueueVerifiedEvents([outcome.event], dependencies)
        return json(result.data)
      }

      if (url.pathname === "/v1/webhooks/qpay") {
        if (request.method !== "GET" && request.method !== "POST") {
          return text("METHOD_NOT_ALLOWED", 405, { Allow: "GET, POST" })
        }
        if (!dependencies.qpay) return text("PAYMENTS_NOT_CONFIGURED", 503)
        await request.body?.cancel().catch(() => undefined)
        const events = await dependencies.qpay({
          reference: PaymentInvoiceReferenceSchema.parse(uniqueQueryValue(url, "invoice", true)),
          callbackPaymentID: uniqueQueryValue(url, "payment_id", false),
        })
        await enqueueVerifiedEvents(events, dependencies)
        return text("SUCCESS")
      }

      if (url.pathname === "/v1/webhooks/bonum") {
        if (request.method !== "POST") return text("METHOD_NOT_ALLOWED", 405, { Allow: "POST" })
        if (!dependencies.bonum) return text("PAYMENTS_NOT_CONFIGURED", 503)
        const contentType = request.headers.get("content-type")?.toLowerCase() ?? ""
        if (!contentType.includes("application/json")) return text("INVALID_REQUEST", 400)
        const checksum = request.headers.get("x-checksum-v2") ?? ""
        const events = await dependencies.bonum({
          rawBody: await readBoundedBody(request),
          checksum,
        })
        await enqueueVerifiedEvents(events, dependencies)
        return text("SUCCESS")
      }

      return text("NOT_FOUND", 404)
    } catch (error) {
      console.error("Payment webhook request failed", {
        path: url.pathname,
        ray: request.headers.get("cf-ray") ?? "unknown",
        error: error instanceof Error ? error.name : typeof error,
      })
      if (error instanceof PaymentQueueUnavailableError) {
        if (url.pathname === "/v1/checkouts/subscription/cancel") {
          return json(
            {
              error: "Нэхэмжлэх цуцлагдсан боловч төлөв шинэчлэх дараалал түр ажиллахгүй байна. Дахин шалгана уу.",
              code: "queue_unavailable",
            },
            503,
          )
        }
        return text("TRY_AGAIN", 503)
      }
      if (error instanceof PaymentIngressNotFoundError) return text("NOT_FOUND", 404)
      if (error instanceof BonumWebhookVerificationError) {
        return text("INVALID_WEBHOOK", error.code === "signature" ? 401 : 400)
      }
      if (error instanceof PaymentProviderResponseError) return text("TRY_AGAIN", error.retryable ? 503 : 502)
      if (error instanceof PaymentCheckoutAuthorizationError) {
        return json(
          {
            error: "Энэ ажлын талбарт төлбөр удирдах эрх алга.",
            code: "workspace_admin_required",
          },
          403,
        )
      }
      if (error instanceof PaymentCheckoutConflictError) {
        return json(
          {
            error: checkoutConflictMessage(error.state),
            code: error.state,
            ...(error.invoiceID ? { invoiceID: error.invoiceID } : {}),
          },
          409,
        )
      }
      if (error instanceof PaymentCheckoutCreationError) {
        return json(
          {
            error:
              error.state === "unknown"
                ? "Нэхэмжлэхийн төлөв тодорхойгүй байна. Давтан төлөхөөс өмнө дэмжлэгтэй холбогдоно уу."
                : "Нэхэмжлэх үүсгэж чадсангүй.",
            code: error.code,
          },
          error.state === "unknown" ? 503 : 502,
        )
      }
      if (error instanceof PaymentCancellationAuthorizationError) {
        return json({ error: "Энэ ажлын талбарт төлбөр цуцлах эрх алга.", code: "workspace_admin_required" }, 403)
      }
      if (error instanceof PaymentCancellationUnsupportedError) {
        return json(
          {
            error: "Bonum нэхэмжлэхийг API-аар цуцлах боломж албан ёсоор дэмжигдээгүй. Хугацаа дуусахыг хүлээнэ үү.",
            code: "provider_cancellation_unsupported",
          },
          409,
        )
      }
      if (error instanceof PaymentCancellationUnavailableError) {
        return json({ error: "QPay цуцлалтын үйлчилгээ тохируулагдаагүй байна.", code: "provider_unavailable" }, 503)
      }
      if (error instanceof PaymentCancellationConflictError) {
        return json(
          {
            error: cancellationConflictMessage(error.state),
            code: error.state,
          },
          error.state === "settled" ? 409 : 422,
        )
      }
      if (error instanceof PaymentCancellationOperationError) {
        return json(
          {
            error:
              error.state === "unknown"
                ? "Цуцлалтын үр дүн тодорхойгүй байна. Давтан цуцлахгүйгээр дэмжлэгтэй холбогдоно уу."
                : "QPay цуцлах хүсэлтийг зөвшөөрсөнгүй.",
            code: error.code,
          },
          error.state === "unknown" ? 503 : 502,
        )
      }
      if (error instanceof InvalidPaymentCheckoutResponseError) {
        return json({ error: "Төлбөрийн үйлчилгээ буруу хариу буцаалаа." }, 502)
      }
      if (error instanceof RangeError && url.pathname === "/v1/checkouts/subscription") {
        return json({ error: "Төлбөрийн хүсэлт хэт том байна." }, 413)
      }
      if (error instanceof RangeError && url.pathname === "/v1/checkouts/subscription/cancel") {
        return json({ error: "Цуцлах хүсэлт хэт том байна." }, 413)
      }
      if (error instanceof RangeError) return text("PAYLOAD_TOO_LARGE", 413)
      if (url.pathname === "/v1/checkouts/subscription" || url.pathname === "/v1/checkouts/subscription/cancel") {
        return json({ error: "Төлбөрийн үйлчилгээний дотоод алдаа гарлаа.", code: "internal_error" }, 500)
      }
      if (error instanceof InvalidPaymentWebhookRequestError) return text("INVALID_REQUEST", 400)
      if (error instanceof z.ZodError || error instanceof SyntaxError) return text("INVALID_REQUEST", 400)
      return text("INTERNAL_ERROR", 500)
    }
  }
}

function checkoutConflictMessage(state: PaymentCheckoutConflictError["state"]) {
  if (state === "active_subscription") return "Энэ ажлын талбар идэвхтэй багцтай байна."
  if (state === "open_checkout") return "Өмнөх төлбөрийн нэхэмжлэх дуусаагүй байна."
  if (state === "request_in_progress") return "Нэхэмжлэх үүсгэж байна. Түр хүлээгээд дахин шалгана уу."
  return "Энэ төлбөрийн хүсэлт хаагдсан байна. Шинэ хүсэлт үүсгэнэ үү."
}

function cancellationConflictMessage(state: PaymentCancellationConflictError["state"]) {
  if (state === "settled") return "Төлбөр аль хэдийн баталгаажсан тул нэхэмжлэх цуцлах боломжгүй."
  if (state === "not_cancellable") return "Энэ нэхэмжлэхийг одоогийн төлвөөс цуцлах боломжгүй."
  if (state === "request_in_progress") return "Нэхэмжлэхийг цуцалж байна. Түр хүлээгээд төлвийг дахин ачаална уу."
  if (state === "result_unknown")
    return "Цуцлалтын үр дүн тодорхойгүй байна. Давтан цуцлахгүйгээр дэмжлэгтэй холбогдоно уу."
  return "Өмнөх цуцлах хүсэлт амжилтгүй болсон. Нэхэмжлэхийн одоогийн төлвийг шалгана уу."
}

let runtimeDependencies: Dependencies | undefined

function defaults() {
  if (runtimeDependencies) return runtimeDependencies
  const config = Resource.PaymentConfig
  const qpaySecrets = {
    merchantAccountID: Resource.QPayMerchantAccountID.value,
    clientID: Resource.QPayClientID.value,
    clientSecret: Resource.QPayClientSecret.value,
    invoiceCode: Resource.QPayInvoiceCode.value,
  }
  const bonumSecrets = {
    merchantAccountID: Resource.BonumMerchantAccountID.value,
    appSecret: Resource.BonumAppSecret.value,
    terminalID: Resource.BonumTerminalID.value,
    webhookChecksumKey: Resource.BonumWebhookChecksumKey.value,
  }
  const configured = (values: Record<string, string>) =>
    config.enabled && Object.values(values).every((value) => value && value !== "disabled")

  const qpay = configured(qpaySecrets)
    ? new QPayAdapter({
        environment: config.environment,
        ...qpaySecrets,
        invoiceCallbackURL: `${config.callbackBaseURL}/v1/webhooks/qpay`,
        timeoutMs: 8_000,
      })
    : undefined
  const bonum = configured(bonumSecrets)
    ? new BonumAdapter({
        environment: config.environment,
        ...bonumSecrets,
        invoiceCallbackURL: `${config.callbackBaseURL}/v1/webhooks/bonum`,
        providers: config.bonumProviders,
        timeoutMs: 8_000,
      })
    : undefined
  const catalog = (() => {
    if (!config.enabled) return undefined
    try {
      return PaymentPlanCatalogSchema.parse(JSON.parse(config.planCatalog))
    } catch {
      return undefined
    }
  })()

  runtimeDependencies = {
    qpay: qpay ? (input) => reconcileQPayCallback(input, { adapter: qpay }) : undefined,
    bonum: bonum ? (input) => verifyBonumWebhook(input, { adapter: bonum }) : undefined,
    internalToken: Resource.PaymentServiceToken.value,
    createSubscriptionCheckout: config.enabled
      ? async (input) => {
          const adapter = input.provider === "qpay" ? qpay : bonum
          if (!adapter) throw new PaymentCheckoutCreationError("failed", "provider_not_configured")
          if (!catalog) throw new PaymentCheckoutCreationError("failed", "catalog_not_configured")
          return createSubscriptionCheckout(input, { adapter, catalog })
        }
      : undefined,
    cancelSubscriptionCheckout: config.enabled
      ? (input) => cancelSubscriptionCheckout(input, { adapters: { qpay } })
      : undefined,
    async enqueue(events) {
      await Resource.PaymentQueue.sendBatch(events.map((body) => ({ body })))
    },
  }
  return runtimeDependencies
}

export default {
  fetch(request: Request) {
    return createPaymentWebhookHandler(defaults())(request)
  },
}
