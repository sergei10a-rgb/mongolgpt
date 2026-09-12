import { isAbsolute } from "node:path"

const failure = "Dev payment Pulumi invocation is not approved"
export const paymentPulumiStatuses = [
  "started",
  "environment",
  "command",
  "target",
  "config",
  "duplicate-option",
  "stack",
  "event-log",
  "unknown-option",
  "required-targets",
  "required-configs",
  "required-options",
  "arguments-approved",
  "runtime-home",
  "runtime-file",
  "runtime-version-check",
  "runtime-version",
  "runtime-launch",
  "native-running",
  "native-failed",
  "native-completed",
  "unknown",
] as const

export class PaymentPulumiInvocationError extends Error {
  constructor(readonly status: (typeof paymentPulumiStatuses)[number]) {
    super(failure)
  }
}
const targets = new Set([
  "urn:pulumi:dev::mongolgpt::sst:cloudflare:Worker$cloudflare:index/workersScript:WorkersScript::PaymentServiceScript",
  "urn:pulumi:dev::mongolgpt::sst:cloudflare:Worker$pulumi-nodejs:dynamic:Resource::PaymentServiceUrl.sst.cloudflare.WorkerUrl",
])
const configs = new Set(["cloudflare:version=6.15.0", "random:version=4.19.2"])

export function narrowDevPaymentPulumiArgs(args: string[], env: Record<string, string | undefined>) {
  const expected = {
    CLOUDFLARE_ACCOUNT_ID: "cc97ad90bfaf8a1da5de612eef2658f5",
    CLOUDFLARE_DEFAULT_ACCOUNT_ID: "cc97ad90bfaf8a1da5de612eef2658f5",
    MONGOLGPT_DOMAIN: "mgpt.mn",
    MONGOLGPT_PAYMENT_ENVIRONMENT: "disabled",
    MONGOLGPT_ENABLE_REAL_PAYMENTS: "false",
  }
  if (Object.entries(expected).some(([key, value]) => env[key] !== value))
    throw new PaymentPulumiInvocationError("environment")
  if (!["preview", "up"].includes(args[0]) || args.length > 24) throw new PaymentPulumiInvocationError("command")
  const seen = new Set<string>()
  const selected = new Set<string>()
  const configured = new Set<string>()
  for (let index = 1; index < args.length; index++) {
    const flag = args[index]
    if (flag === "--target" || flag === "--config") {
      const value = args[++index]
      const allowed = flag === "--target" ? targets : configs
      const values = flag === "--target" ? selected : configured
      if (!allowed.has(value) || values.has(value))
        throw new PaymentPulumiInvocationError(flag === "--target" ? "target" : "config")
      values.add(value)
      continue
    }
    if (seen.has(flag)) throw new PaymentPulumiInvocationError("duplicate-option")
    seen.add(flag)
    if (flag === "--stack") {
      if (args[++index] !== "organization/mongolgpt/dev") throw new PaymentPulumiInvocationError("stack")
      continue
    }
    if (flag === "--event-log") {
      const value = args[++index]
      if (!value || !isAbsolute(value) || /[\0\r\n]/.test(value)) throw new PaymentPulumiInvocationError("event-log")
      continue
    }
    if (["--target-dependents", "--non-interactive"].includes(flag)) continue
    if (args[0] === "up" && ["--yes", "-f"].includes(flag)) continue
    throw new PaymentPulumiInvocationError("unknown-option")
  }
  if (selected.size !== targets.size) throw new PaymentPulumiInvocationError("required-targets")
  if (configured.size !== configs.size) throw new PaymentPulumiInvocationError("required-configs")
  const required = ["--stack", "--event-log", "--target-dependents", "--non-interactive"]
  if (args[0] === "up") required.push("--yes", "-f")
  if (required.some((flag) => !seen.has(flag))) throw new PaymentPulumiInvocationError("required-options")
  // SST 4.17.1 always widens target selection. Preserve its state pipeline but use Pulumi's exact targets.
  return args.filter((arg) => arg !== "--target-dependents")
}
