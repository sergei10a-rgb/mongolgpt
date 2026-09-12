import { isDeepStrictEqual } from "node:util"

export const devAdminAccess = {
  accountId: "cc97ad90bfaf8a1da5de612eef2658f5",
  applicationId: "e27fab35-57fc-4905-a2fa-c7e747683399",
  hostname: "admin.dev.mgpt.mn",
  urn: "urn:pulumi:dev::mongolgpt-admin::cloudflare:index/zeroTrustAccessApplication:ZeroTrustAccessApplication::AdminAccessApplication",
} as const

export class AdminAccessStateError extends Error {}

// Preserve opaque/encrypted values verbatim. Only the two recorded cookie attributes may change.
export function reconcileAdminAccessState(input: unknown) {
  const state: unknown = structuredClone(input)
  const target = application(state)
  const before = application(input)
  const changed =
    target.inputs.sameSiteCookieAttribute === "strict" || target.outputs.sameSiteCookieAttribute === "strict"
  target.inputs.sameSiteCookieAttribute = "lax"
  target.outputs.sameSiteCookieAttribute = "lax"

  const restored: unknown = structuredClone(state)
  const check = application(restored)
  check.inputs.sameSiteCookieAttribute = before.inputs.sameSiteCookieAttribute
  check.outputs.sameSiteCookieAttribute = before.outputs.sameSiteCookieAttribute
  if (!isDeepStrictEqual(input, restored)) fail("Unexpected state changes")
  return { state, changed }
}

function application(input: unknown) {
  const root = record(input)
  const checkpoint = root.version === 3 ? record(root.checkpoint) : root
  if ("version" in root && root.version !== 3) fail("Unsupported checkpoint version")
  if (checkpoint.stack !== "dev" && checkpoint.stack !== "organization/mongolgpt-admin/dev")
    fail("Unexpected checkpoint stack")
  const latest = record(checkpoint.latest)
  if (record(latest.secrets_providers).type !== "passphrase") fail("Expected SST passphrase secrets provider")
  requireEncryptedSecrets(checkpoint)
  if (
    latest.pending_operations !== undefined &&
    (!Array.isArray(latest.pending_operations) || latest.pending_operations.length > 0)
  )
    fail("Pending operations must be resolved first")
  if (record(latest.metadata).integrity_error !== undefined) fail("State has an integrity error")
  if (!Array.isArray(latest.resources) || latest.resources.length === 0) fail("Missing resources")
  const resources = latest.resources.map(record)
  if (
    resources.some((item) => typeof item.urn !== "string" || !item.urn.startsWith("urn:pulumi:dev::mongolgpt-admin::"))
  ) {
    fail("Only the isolated dev admin stack is supported")
  }
  const matches = resources.filter((item) => item.urn === devAdminAccess.urn)
  if (matches.length !== 1) fail("Expected exactly one admin Access application")
  const target = matches[0]
  if (
    target.type !== "cloudflare:index/zeroTrustAccessApplication:ZeroTrustAccessApplication" ||
    target.id !== devAdminAccess.applicationId ||
    target.custom !== true ||
    (target.delete !== undefined && target.delete !== false) ||
    (target.pendingReplacement !== undefined && target.pendingReplacement !== false)
  )
    fail("Unexpected application identity or operation")
  const providers = resources.filter(
    (item) =>
      item.type === "pulumi:providers:cloudflare" &&
      typeof item.id === "string" &&
      item.id.length > 0 &&
      `${item.urn}::${item.id}` === target.provider,
  )
  if (providers.length !== 1) fail("Application provider is not uniquely recorded")
  if (!encryptedSecret(record(providers[0].inputs).apiToken)) fail("Access provider credential must remain encrypted")
  const inputs = record(target.inputs)
  const outputs = record(target.outputs)
  for (const values of [inputs, outputs]) {
    if (
      values.accountId !== devAdminAccess.accountId ||
      values.domain !== devAdminAccess.hostname ||
      values.enableBindingCookie !== true ||
      values.httpOnlyCookieAttribute !== true
    ) {
      fail("Application identity or cookie protections do not match")
    }
    if (values.sameSiteCookieAttribute !== "strict" && values.sameSiteCookieAttribute !== "lax")
      fail("Unexpected cookie value")
  }
  if (outputs.id !== undefined && outputs.id !== devAdminAccess.applicationId) fail("Output identity does not match")
  return { inputs, outputs }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function fail(message: string): never {
  throw new AdminAccessStateError(message)
}

function encryptedSecret(value: unknown) {
  const item = record(value)
  return (
    item["4dabf18193072939515e22adb298388d"] === "1b47061264138c4ac30d75fd1eb44270" &&
    typeof item.ciphertext === "string" &&
    item.ciphertext.length > 0 &&
    !Object.hasOwn(item, "plaintext") &&
    !Object.hasOwn(item, "value")
  )
}

function requireEncryptedSecrets(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(requireEncryptedSecrets)
    return
  }
  const item = record(value)
  if (item["4dabf18193072939515e22adb298388d"] === "1b47061264138c4ac30d75fd1eb44270" && !encryptedSecret(item)) {
    fail("Decrypted secret state is not supported")
  }
  Object.values(item).forEach(requireEncryptedSecrets)
}
