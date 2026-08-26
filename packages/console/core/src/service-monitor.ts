import { z } from "zod"

export const SERVICE_MONITOR_STATE_KEY = "service-monitor:latest"
export const SERVICE_MONITOR_TTL_SECONDS = 20 * 60
export const SERVICE_MONITOR_MAX_AGE_MS = 15 * 60 * 1_000
export const SERVICE_MONITOR_SERVICES = ["console", "auth", "runtime", "payments"] as const

const timestamp = z.number().int().min(0).max(8_640_000_000_000_000)

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
    checks: z.array(ServiceMonitorCheckSchema).length(SERVICE_MONITOR_SERVICES.length),
  })
  .strict()
  .superRefine((value, context) => {
    const services = new Set(value.checks.map((check) => check.service))
    if (services.size !== SERVICE_MONITOR_SERVICES.length) {
      context.addIssue({ code: "custom", path: ["checks"], message: "Үйлчилгээний шалгалтууд давхардаж болохгүй." })
    }
    for (const service of SERVICE_MONITOR_SERVICES) {
      if (!services.has(service)) {
        context.addIssue({ code: "custom", path: ["checks"], message: `${service} үйлчилгээний шалгалт дутуу байна.` })
      }
    }
    const expectedStatus = value.checks.every((check) => check.ok) ? "ok" : "degraded"
    if (value.status !== expectedStatus) {
      context.addIssue({ code: "custom", path: ["status"], message: "Нийт төлөв шалгалтын үр дүнтэй зөрж байна." })
    }
  })

export type ServiceMonitorCheck = z.infer<typeof ServiceMonitorCheckSchema>
export type ServiceMonitorEvidence = z.infer<typeof ServiceMonitorEvidenceSchema>
