import { isDeepStrictEqual } from "node:util"
import { PaymentHealthSchema } from "../../console/core/src/service-monitor"

const endpoint = "https://pay.dev.mgpt.mn/health"
const maximumBytes = 16_384
const failure = "Disabled dev payment health verification failed"
const legacy = {
  status: "disabled",
  service: "payments",
  environment: "disabled",
  providers: { qpay: false, bonum: false },
  catalog: false,
  checkout: false,
  cancellation: false,
  refund: false,
}

export async function verifyDevPaymentHealth(
  phase: "before" | "after",
  dependencies: { fetch?: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>; timeoutMs?: number } = {},
) {
  const timeoutMs = dependencies.timeoutMs ?? 10_000
  if (!["before", "after"].includes(phase) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000)
    throw new Error(failure)
  const controller = new AbortController()
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(failure)), timeoutMs)
      }),
      (async () => {
        const response = await (dependencies.fetch ?? fetch)(endpoint, {
          method: "GET",
          headers: { Accept: "application/json" },
          redirect: "error",
          cache: "no-store",
          signal: controller.signal,
        })
        if (
          response.status !== 200 ||
          response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json"
        ) {
          void response.body?.cancel().catch(() => undefined)
          throw new Error(failure)
        }
        reader = response.body?.getReader()
        if (!reader) throw new Error(failure)
        const decoder = new TextDecoder("utf-8", { fatal: true })
        let bytes = 0
        let body = ""
        while (true) {
          const part = await reader.read()
          if (part.done) break
          bytes += part.value.byteLength
          if (bytes > maximumBytes) throw new Error(failure)
          body += decoder.decode(part.value, { stream: true })
        }
        const value: unknown = JSON.parse(body + decoder.decode())
        const current = PaymentHealthSchema.safeParse(value)
        if (
          current.success &&
          current.data.status === "disabled" &&
          current.data.environment === "disabled" &&
          !current.data.catalog &&
          !current.data.checkout &&
          !current.data.cancellation &&
          !current.data.refund &&
          Object.values(current.data.providers).every((provider) => Object.values(provider).every((flag) => !flag))
        )
          return { stage: "dev", service: "payments", phase, environment: "disabled", contract: "current" }
        // Permit the observed old health shape only before updating the disabled service.
        if (phase === "before" && isDeepStrictEqual(value, legacy))
          return { stage: "dev", service: "payments", phase, environment: "disabled", contract: "legacy" }
        throw new Error(failure)
      })(),
    ])
  } catch {
    throw new Error(failure)
  } finally {
    clearTimeout(timer)
    controller.abort()
    if (reader) {
      void reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  }
}
