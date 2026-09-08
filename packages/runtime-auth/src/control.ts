import { Buffer } from "node:buffer"
import { createHmac, timingSafeEqual } from "node:crypto"

const minSecretLength = 32
const maxSecretLength = 8192
const minScopeLength = 1
const maxScopeLength = 1024
const maxIDLength = 256
const controlPrefix = "mongolgpt-control-v1"
const controlTokenPattern = /^[0-9a-f]{64}$/
const asciiControlPattern = /[\x00-\x1f\x7f]/

export const sdkControlHeader = "x-mongolgpt-control-token"
export const checkpointControlHeader = "x-mongolgpt-checkpoint-token"
export const sdkControlEnv = "MONGOLGPT_SDK_CONTROL_TOKEN"
export const checkpointControlEnv = "MONGOLGPT_CHECKPOINT_CONTROL_TOKEN"

export async function deriveControlToken(
  secret: string,
  scope: string,
  purpose: "sdk" | "checkpoint",
): Promise<string> {
  return createHmac("sha256", requireSecret(secret))
    .update(JSON.stringify([controlPrefix, requirePurpose(purpose), requireScope(scope)]), "utf8")
    .digest("hex")
}

export function validControlToken(value: unknown): value is string {
  return typeof value === "string" && value.length === 64 && controlTokenPattern.test(value)
}

export function matchesControlToken(provided: string | null, expected: string): boolean {
  if (!validControlToken(provided) || !validControlToken(expected)) return false
  return timingSafeEqual(Buffer.from(provided, "utf8"), Buffer.from(expected, "utf8"))
}

export async function deriveCheckpointControlToken(
  secret: string,
  input: { accountID: string; workspaceID: string },
): Promise<string> {
  return await deriveControlToken(
    secret,
    JSON.stringify([requireID(input.accountID), requireID(input.workspaceID)]),
    "checkpoint",
  )
}

function requireSecret(value: unknown): string {
  if (typeof value !== "string" || value.length < minSecretLength || value.length > maxSecretLength) {
    throw new TypeError("Invalid control secret")
  }
  return value
}

function requireScope(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < minScopeLength ||
    value.length > maxScopeLength ||
    asciiControlPattern.test(value)
  ) {
    throw new TypeError("Invalid control scope")
  }
  return value
}

function requireID(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxIDLength ||
    asciiControlPattern.test(value)
  ) {
    throw new TypeError("Invalid checkpoint control scope")
  }
  return value
}

function requirePurpose(value: unknown): "sdk" | "checkpoint" {
  if (value !== "sdk" && value !== "checkpoint") throw new TypeError("Invalid control purpose")
  return value
}
