export type ConfigInvalidError = {
  name: "ConfigInvalidError"
  data: {
    path?: string
    message?: string
    issues?: Array<{ message: string; path: string[] }>
  }
}

export type ProviderModelNotFoundError = {
  name: "ProviderModelNotFoundError"
  data: {
    providerID: string
    modelID: string
    suggestions?: string[]
  }
}

type Translator = (key: string, vars?: Record<string, string | number>) => string

function tr(translator: Translator | undefined, key: string, text: string, vars?: Record<string, string | number>) {
  if (!translator) return text
  const out = translator(key, vars)
  if (!out || out === key) return text
  return out
}

export function formatServerError(error: unknown, translate?: Translator, fallback?: string) {
  const unwrapped = unwrapNamedError(error)
  if (isConfigInvalidErrorLike(unwrapped)) return parseReadableConfigInvalidError(unwrapped, translate)
  if (isProviderModelNotFoundErrorLike(unwrapped)) return parseReadableProviderModelNotFoundError(unwrapped, translate)
  if (!translate) {
    if (error instanceof Error && error.message) return error.message
    if (typeof error === "string" && error) return error
    if (fallback) return fallback
    return "Тодорхойгүй алдаа"
  }

  const status = readErrorStatus(error)
  if (status !== undefined) {
    return tr(translate, "error.chain.httpStatus", "Сервер {{status}} төлөвтэй хариу өглөө", { status })
  }

  const message = readErrorMessage(error)
  if (message) {
    const normalized = message.toLowerCase()
    if (/timeout|timed out|deadline exceeded/.test(normalized)) {
      return tr(translate, "error.chain.timeout", "Хүсэлтийн хугацаа дууслаа")
    }
    if (/abort|aborted|cancelled|canceled/.test(normalized)) {
      return tr(translate, "error.chain.cancelled", "Хүсэлтийг цуцаллаа")
    }
    if (/failed to fetch|network|econnrefused|enotfound|connection|connect to server/.test(normalized)) {
      return tr(translate, "error.chain.connectionFailed", "Сервертэй холбогдож чадсангүй")
    }
  }

  if (fallback) return fallback
  return message
    ? tr(translate, "error.chain.requestFailed", "Хүсэлт амжилтгүй боллоо")
    : tr(translate, "error.chain.unknown", "Тодорхойгүй алдаа")
}

function readErrorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  if (typeof error !== "object" || error === null) return
  const value = error as Record<string, unknown>
  if (typeof value.message === "string" && value.message) return value.message
  if (typeof value.data === "object" && value.data !== null) {
    const message = (value.data as Record<string, unknown>).message
    if (typeof message === "string" && message) return message
  }
}

function readErrorStatus(error: unknown): number | string | undefined {
  const values: unknown[] = [error]
  if (error instanceof Error && error.cause) values.push(error.cause)

  for (const value of values) {
    if (typeof value !== "object" || value === null) continue
    const record = value as Record<string, unknown>
    const status = record.status ?? record.statusCode
    if (typeof status === "number" || (typeof status === "string" && status)) return status
    if (typeof record.data === "object" && record.data !== null) {
      const data = record.data as Record<string, unknown>
      const nested = data.status ?? data.statusCode
      if (typeof nested === "number" || (typeof nested === "string" && nested)) return nested
    }
  }

  const match = readErrorMessage(error)?.match(/(?:status|http)\s*[:=]?\s*(\d{3})/i)
  return match?.[1]
}

function unwrapNamedError(error: unknown): unknown {
  if (error instanceof Error && error.cause && typeof error.cause === "object" && "body" in error.cause) {
    return (error.cause as Record<string, unknown>).body
  }
  return error
}

export function isSessionNotFoundError(error: unknown, sessionID: string) {
  const unwrapped = unwrapNamedError(error)
  if (typeof unwrapped !== "object" || unwrapped === null) return false
  const value = unwrapped as Record<string, unknown>
  return value._tag === "SessionNotFoundError" && value.sessionID === sessionID
}

function isConfigInvalidErrorLike(error: unknown): error is ConfigInvalidError {
  if (typeof error !== "object" || error === null) return false
  const o = error as Record<string, unknown>
  return o.name === "ConfigInvalidError" && typeof o.data === "object" && o.data !== null
}

function isProviderModelNotFoundErrorLike(error: unknown): error is ProviderModelNotFoundError {
  if (typeof error !== "object" || error === null) return false
  const o = error as Record<string, unknown>
  return o.name === "ProviderModelNotFoundError" && typeof o.data === "object" && o.data !== null
}

export function parseReadableConfigInvalidError(errorInput: ConfigInvalidError, translator?: Translator) {
  const file = errorInput.data.path && errorInput.data.path !== "config" ? errorInput.data.path : "config"
  const detail = errorInput.data.message?.trim() ?? ""
  const issues = (errorInput.data.issues ?? [])
    .map((issue) => {
      const msg = issue.message.trim()
      if (!issue.path.length) return msg
      return `${issue.path.join(".")}: ${msg}`
    })
    .filter(Boolean)
  const msg = issues.length ? issues.join("\n") : detail
  if (!msg)
    return tr(translator, "error.chain.configInvalid", `${file} дээрх тохиргооны файл буруу байна`, { path: file })
  return tr(translator, "error.chain.configInvalidWithMessage", `${file} дээрх тохиргооны файл буруу байна: ${msg}`, {
    path: file,
    message: msg,
  })
}

function parseReadableProviderModelNotFoundError(errorInput: ProviderModelNotFoundError, translator?: Translator) {
  const p = errorInput.data.providerID.trim()
  const m = errorInput.data.modelID.trim()
  const list = (errorInput.data.suggestions ?? []).map((v) => v.trim()).filter(Boolean)
  const body = tr(translator, "error.chain.modelNotFound", `Загвар олдсонгүй: ${p}/${m}`, { provider: p, model: m })
  const tail = tr(
    translator,
    "error.chain.checkConfig",
    "Өөрийн тохиргооны (mongolgpt.json) үйлчилгээ үзүүлэгч/загварын нэрийг шалгана уу",
  )
  if (list.length) {
    const suggestions = list.slice(0, 5).join(", ")
    return [
      body,
      tr(translator, "error.chain.didYouMean", `Та: ${suggestions} гэсэн үг үү`, { suggestions }),
      tail,
    ].join("\n")
  }
  return [body, tail].join("\n")
}
