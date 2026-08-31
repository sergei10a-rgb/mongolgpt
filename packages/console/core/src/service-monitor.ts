import { z } from "zod"

export const SERVICE_MONITOR_STATE_KEY = "service-monitor:latest"
export const SERVICE_MONITOR_TTL_SECONDS = 20 * 60
export const SERVICE_MONITOR_MAX_AGE_MS = 15 * 60 * 1_000
export const SERVICE_MONITOR_ALERT_STATE_KEY = "service-monitor:alert-state"
export const SERVICE_MONITOR_ALERT_STATE_TTL_SECONDS = 31 * 24 * 60 * 60
export const SERVICE_MONITOR_ALERT_REMINDER_MS = 60 * 60 * 1_000
export const SERVICE_MONITOR_ALERT_STATE_MAX_AGE_MS = 2 * SERVICE_MONITOR_ALERT_REMINDER_MS
export const SERVICE_MONITOR_REQUIRED_SERVICES = ["console", "auth", "runtime", "payments", "docs"] as const
export const SERVICE_MONITOR_SERVICES = [...SERVICE_MONITOR_REQUIRED_SERVICES, "admin"] as const

const timestamp = z.number().int().min(0).max(8_640_000_000_000_000)

export const PaymentProviderCapabilitySchema = z
  .object({
    enabled: z.boolean(),
    checkout: z.boolean(),
    cancellation: z.boolean(),
    refund: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.enabled || (!value.checkout && !value.cancellation && !value.refund)) return
    context.addIssue({
      code: "custom",
      message: "Идэвхгүй төлбөрийн provider capability зарлаж болохгүй.",
    })
  })

export const PaymentHealthSchema = z
  .object({
    status: z.enum(["ok", "degraded", "disabled"]),
    service: z.literal("payments"),
    environment: z.enum(["disabled", "sandbox", "production"]),
    providers: z
      .object({
        qpay: PaymentProviderCapabilitySchema,
        bonum: PaymentProviderCapabilitySchema,
      })
      .strict(),
    catalog: z.boolean(),
    checkout: z.boolean(),
    cancellation: z.boolean(),
    refund: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    const enabledProviders = Object.values(value.providers).filter((provider) => provider.enabled)
    const everyEnabled = (field: "checkout" | "cancellation" | "refund") =>
      enabledProviders.length > 0 && enabledProviders.every((provider) => provider[field])

    const expectedCheckout = everyEnabled("checkout")
    const expectedCancellation = everyEnabled("cancellation")
    const expectedRefund = everyEnabled("refund")
    const disabledClean = enabledProviders.length === 0 && !value.catalog
    const checkoutReady = value.catalog && expectedCheckout
    const expectedStatus =
      value.environment === "disabled" ? (disabledClean ? "disabled" : "degraded") : checkoutReady ? "ok" : "degraded"

    if (value.checkout !== expectedCheckout) {
      context.addIssue({
        code: "custom",
        path: ["checkout"],
        message: "Нийт checkout чадвар provider матрицтай зөрж байна.",
      })
    }
    if (value.cancellation !== expectedCancellation) {
      context.addIssue({
        code: "custom",
        path: ["cancellation"],
        message: "Нийт cancellation чадвар provider матрицтай зөрж байна.",
      })
    }
    if (value.refund !== expectedRefund) {
      context.addIssue({
        code: "custom",
        path: ["refund"],
        message: "Нийт refund чадвар provider матрицтай зөрж байна.",
      })
    }
    if (value.status !== expectedStatus) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Төлбөрийн нийт төлөв capability матрицтай зөрж байна.",
      })
    }
  })

export const ServiceMonitorCheckSchema = z
  .object({
    service: z.enum(SERVICE_MONITOR_SERVICES),
    ok: z.boolean(),
    httpStatus: z.number().int().min(100).max(599).optional(),
    latencyMs: z.number().int().min(0).max(60_000),
    failure: z.enum(["timeout", "network", "http", "schema"]).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.ok && value.failure) {
      context.addIssue({ code: "custom", message: "Хэвийн шалгалт failure утгатай байж болохгүй." })
    }
    if (!value.ok && !value.failure) {
      context.addIssue({ code: "custom", message: "Амжилтгүй шалгалт failure утгатай байна." })
    }
  })

export const ServiceMonitorEvidenceSchema = z
  .object({
    version: z.literal(1),
    stage: z
      .string()
      .trim()
      .min(1)
      .max(63)
      .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
    checkedAt: timestamp,
    status: z.enum(["ok", "degraded"]),
    checks: z
      .array(ServiceMonitorCheckSchema)
      .min(SERVICE_MONITOR_REQUIRED_SERVICES.length)
      .max(SERVICE_MONITOR_SERVICES.length),
  })
  .strict()
  .superRefine((value, context) => {
    const services = new Set(value.checks.map((check) => check.service))
    if (services.size !== value.checks.length) {
      context.addIssue({ code: "custom", path: ["checks"], message: "Үйлчилгээний шалгалтууд давхардаж болохгүй." })
    }
    for (const service of SERVICE_MONITOR_REQUIRED_SERVICES) {
      if (!services.has(service)) {
        context.addIssue({ code: "custom", path: ["checks"], message: `${service} үйлчилгээний шалгалт дутуу байна.` })
      }
    }
    if (value.stage === "production" && !services.has("admin")) {
      context.addIssue({ code: "custom", path: ["checks"], message: "admin үйлчилгээний шалгалт дутуу байна." })
    }
    const expectedStatus = value.checks.every((check) => check.ok) ? "ok" : "degraded"
    if (value.status !== expectedStatus) {
      context.addIssue({ code: "custom", path: ["status"], message: "Нийт төлөв шалгалтын үр дүнтэй зөрж байна." })
    }
  })

export const ServiceMonitorAlertStateSchema = z
  .object({
    version: z.literal(1),
    stage: z
      .string()
      .trim()
      .min(1)
      .max(63)
      .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
    status: z.enum(["ok", "degraded"]),
    fingerprint: z.string().trim().min(1).max(512),
    recordedAt: timestamp,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "ok" && value.fingerprint !== "ok") {
      context.addIssue({
        code: "custom",
        path: ["fingerprint"],
        message: "Хэвийн alert төлөвийн fingerprint ok байна.",
      })
    }
    if (value.status === "degraded" && value.fingerprint === "ok") {
      context.addIssue({
        code: "custom",
        path: ["fingerprint"],
        message: "Доголдсон alert төлөвийн fingerprint ok байж болохгүй.",
      })
    }
  })

export type ServiceMonitorCheck = z.infer<typeof ServiceMonitorCheckSchema>
export type ServiceMonitorEvidence = z.infer<typeof ServiceMonitorEvidenceSchema>
export type ServiceMonitorAlertState = z.infer<typeof ServiceMonitorAlertStateSchema>
export type PaymentHealth = z.infer<typeof PaymentHealthSchema>
