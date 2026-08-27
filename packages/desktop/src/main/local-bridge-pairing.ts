import {
  createLocalBridgeCallback,
  parseLocalBridgePairingUrl,
  type LocalBridgePairingRequest,
} from "@mongolgpt/local-bridge"
import type { LocalBridgeAuthorization } from "./local-bridge-gateway"
import type { DesktopAccount } from "../preload/types"

export type LocalBridgePairingConfirmation = (request: LocalBridgePairingRequest) => Promise<boolean>

export type DesktopLocalBridgePairingDependencies = {
  allowedOrigins: readonly string[]
  currentAccount: () => Promise<Pick<DesktopAccount, "id"> | null>
  confirm: LocalBridgePairingConfirmation
  authorize: (request: LocalBridgePairingRequest) => Promise<LocalBridgeAuthorization>
  openExternal: (url: string) => Promise<unknown>
}

export type DesktopLocalBridgePairingResult = { status: "opened" } | { status: "denied" }

export class DesktopLocalBridgePairingError extends Error {
  readonly code: "invalid_request" | "not_authenticated" | "account_mismatch" | "operation_failed"

  constructor(code: DesktopLocalBridgePairingError["code"]) {
    super(publicMessage(code))
    this.name = "DesktopLocalBridgePairingError"
    this.code = code
  }
}

export function createDesktopLocalBridgePairingController(dependencies: DesktopLocalBridgePairingDependencies) {
  const handle = async (value: string): Promise<DesktopLocalBridgePairingResult> => {
    const request = parseRequest(value, dependencies.allowedOrigins)
    const account = await currentAccount(dependencies)
    if (!account) throw new DesktopLocalBridgePairingError("not_authenticated")
    if (account.id !== request.accountID) throw new DesktopLocalBridgePairingError("account_mismatch")

    let approved: boolean
    try {
      approved = await dependencies.confirm(request)
    } catch {
      throw new DesktopLocalBridgePairingError("operation_failed")
    }
    if (!approved) return { status: "denied" }

    const confirmedAccount = await currentAccount(dependencies)
    if (!confirmedAccount) throw new DesktopLocalBridgePairingError("not_authenticated")
    if (confirmedAccount.id !== request.accountID) throw new DesktopLocalBridgePairingError("account_mismatch")

    try {
      const authorization = await dependencies.authorize(request)
      const callback = createLocalBridgeCallback({
        origin: request.origin,
        state: request.state,
        port: authorization.port,
        code: authorization.code,
      })
      await dependencies.openExternal(callback)
      return { status: "opened" }
    } catch {
      throw new DesktopLocalBridgePairingError("operation_failed")
    }
  }

  return { handle }
}

function parseRequest(value: string, allowedOrigins: readonly string[]) {
  try {
    return parseLocalBridgePairingUrl(value, allowedOrigins)
  } catch {
    throw new DesktopLocalBridgePairingError("invalid_request")
  }
}

async function currentAccount(dependencies: DesktopLocalBridgePairingDependencies) {
  try {
    return await dependencies.currentAccount()
  } catch {
    throw new DesktopLocalBridgePairingError("operation_failed")
  }
}

function publicMessage(code: DesktopLocalBridgePairingError["code"]) {
  const messages: Record<DesktopLocalBridgePairingError["code"], string> = {
    invalid_request: "Дотоод холболтын хүсэлт буруу байна",
    not_authenticated: "Эхлээд MongolGPT Desktop-д нэвтэрнэ үү",
    account_mismatch: "Дотоод холболтын хүсэлт энэ Desktop бүртгэлтэй таарахгүй байна",
    operation_failed: "Дотоод холболтыг дуусгаж чадсангүй",
  }
  return messages[code]
}
