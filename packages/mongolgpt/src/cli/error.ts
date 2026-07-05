import { NamedError } from "@mongolgpt/core/util/error"
import { errorFormat } from "@/util/error"
import { isRecord } from "@/util/record"

type ConfigIssue = { message: string; path: string[] }

function isTaggedError(error: unknown, tag: string): error is Record<string, unknown> {
  return isRecord(error) && error._tag === tag
}

function configData(input: unknown, tag: string): Record<string, unknown> | undefined {
  if (!isRecord(input)) return undefined
  if (input.name === tag && isRecord(input.data)) return input.data
  if (input._tag === tag) return input
  return undefined
}

function stringField(input: Record<string, unknown>, key: string): string | undefined {
  return typeof input[key] === "string" ? input[key] : undefined
}

function configIssues(input: Record<string, unknown>): ConfigIssue[] {
  return Array.isArray(input.issues)
    ? input.issues.filter((issue): issue is ConfigIssue => {
        if (!isRecord(issue)) return false
        return (
          typeof issue.message === "string" &&
          Array.isArray(issue.path) &&
          issue.path.every((x) => typeof x === "string")
        )
      })
    : []
}

export function FormatError(input: unknown): string | undefined {
  if (input instanceof Error && isRecord(input.cause) && "body" in input.cause) {
    const formatted = FormatError(input.cause.body)
    if (formatted) return formatted
  }

  // CliError: domain failure surfaced from an effectCmd handler via fail("...")
  if (isTaggedError(input, "CliError")) {
    if (typeof input.exitCode === "number") process.exitCode = input.exitCode
    return stringField(input, "message") ?? ""
  }

  // MCPFailed: { name: string }
  if (NamedError.hasName(input, "MCPFailed")) {
    const data = isRecord(input) && isRecord(input.data) ? stringField(input.data, "name") : undefined
    return `"${data}" MCP сервер амжилтгүй боллоо. Анхаар: MongolGPT одоогоор MCP authentication дэмжихгүй.`
  }

  // AccountServiceError, AccountTransportError: TaggedErrorClass
  if (isTaggedError(input, "AccountServiceError") || isTaggedError(input, "AccountTransportError")) {
    return stringField(input, "message") ?? ""
  }

  // ProviderModelNotFoundError: { providerID: string, modelID: string, suggestions?: string[] }
  const providerModelNotFound = configData(input, "ProviderModelNotFoundError")
  if (providerModelNotFound) {
    const suggestions = Array.isArray(providerModelNotFound.suggestions)
      ? providerModelNotFound.suggestions.filter((x) => typeof x === "string")
      : []
    return [
      `Model олдсонгүй: ${stringField(providerModelNotFound, "providerID")}/${stringField(providerModelNotFound, "modelID")}`,
      ...(suggestions.length ? ["Та үүнийг хэлсэн үү: " + suggestions.join(", ")] : []),
      `Боломжит model-уудыг харахын тулд \`mongolgpt models\` ажиллуулна уу`,
      `Эсвэл config (mongolgpt.json) доторх provider/model нэрээ шалгана уу`,
    ].join("\n")
  }

  // ProviderInitError: { providerID: string }
  const providerInit = configData(input, "ProviderInitError")
  if (providerInit) {
    return `"${stringField(providerInit, "providerID")}" provider-ийг эхлүүлж чадсангүй. Credential болон тохиргоогоо шалгана уу.`
  }

  // ConfigJsonError: { path: string, message?: string }
  const configJson = configData(input, "ConfigJsonError")
  if (configJson) {
    const message = stringField(configJson, "message")
    return `${stringField(configJson, "path")} дахь config файл хүчинтэй JSON(C) биш` + (message ? `: ${message}` : "")
  }

  // ConfigDirectoryTypoError: { dir: string, path: string, suggestion: string }
  const configDirectoryTypo = configData(input, "ConfigDirectoryTypoError")
  if (configDirectoryTypo) {
    return `${stringField(configDirectoryTypo, "path")} дахь "${stringField(configDirectoryTypo, "dir")}" хавтас хүчинтэй биш. Хавтсыг "${stringField(configDirectoryTypo, "suggestion")}" гэж нэрлэ, эсвэл устгана уу. Энэ нь түгээмэл typo.`
  }

  // ConfigFrontmatterError: { message: string }
  const configFrontmatter = configData(input, "ConfigFrontmatterError")
  if (configFrontmatter) {
    return stringField(configFrontmatter, "message") ?? ""
  }

  // ConfigRemoteAuthError: { url: string, remote: string }
  const remoteAuth = configData(input, "ConfigRemoteAuthError")
  if (remoteAuth) {
    const url = stringField(remoteAuth, "url")
    const remote = stringField(remoteAuth, "remote")
    return [
      `Remote config${remote ? ` (${remote})` : ""} ачаалж чадсангүй: сервер JSON-ийн оронд login page буцаалаа.`,
      `Authentication алга эсвэл хугацаа нь дууссан байна (endpoint нь SSO эсвэл identity-aware proxy-ийн ард байх магадлалтай).`,
      ...(url ? [`Дахин нэвтрэхийн тулд \`mongolgpt auth login ${url}\` ажиллуулна уу.`] : []),
    ].join("\n")
  }

  // ConfigInvalidError: { path?: string, message?: string, issues?: Array<{ message: string, path: string[] }> }
  const configInvalid = configData(input, "ConfigInvalidError")
  if (configInvalid) {
    const path = stringField(configInvalid, "path")
    const message = stringField(configInvalid, "message")
    const issues = configIssues(configInvalid)
    return [
      `Тохиргоо хүчинтэй биш${path && path !== "config" ? ` (${path})` : ""}` + (message ? `: ${message}` : ""),
      ...issues.map((issue) => "↳ " + issue.message + " " + issue.path.join(".")),
    ].join("\n")
  }

  // UICancelledError: user cancelled an interactive CLI prompt
  if (isTaggedError(input, "UICancelledError") || NamedError.hasName(input, "UICancelledError")) {
    return ""
  }
  return undefined
}

export function FormatUnknownError(input: unknown): string {
  return errorFormat(input)
}
