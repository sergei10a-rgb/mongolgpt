import { expect, test } from "bun:test"
import { narrowDevPaymentPulumiArgs } from "../src/payment-service-pulumi-args"

const err = "Dev payment Pulumi invocation is not approved"
const account = "cc97ad90bfaf8a1da5de612eef2658f5"
const scriptUrn =
  "urn:pulumi:dev::mongolgpt::sst:cloudflare:Worker$cloudflare:index/workersScript:WorkersScript::PaymentServiceScript"
const urlUrn =
  "urn:pulumi:dev::mongolgpt::sst:cloudflare:Worker$pulumi-nodejs:dynamic:Resource::PaymentServiceUrl.sst.cloudflare.WorkerUrl"
const eventLog = process.platform === "win32" ? "C:\\runner\\_temp\\pulumi-eventlog.json" : "/tmp/pulumi-eventlog.json"

const env = {
  CLOUDFLARE_ACCOUNT_ID: account,
  CLOUDFLARE_DEFAULT_ACCOUNT_ID: account,
  MONGOLGPT_DOMAIN: "mgpt.mn",
  MONGOLGPT_PAYMENT_ENVIRONMENT: "disabled",
  MONGOLGPT_ENABLE_REAL_PAYMENTS: "false",
}

function args(command: "preview" | "up") {
  return [
    command,
    ...(command === "up" ? ["--yes", "-f"] : []),
    "--stack",
    "organization/mongolgpt/dev",
    "--non-interactive",
    "--event-log",
    eventLog,
    "--config",
    "cloudflare:version=6.15.0",
    "--config",
    "random:version=4.19.2",
    "--target",
    scriptUrn,
    "--target",
    urlUrn,
    "--target-dependents",
  ]
}

function rejects(input: string[], overrides: Record<string, string | undefined> = {}) {
  expect(() => narrowDevPaymentPulumiArgs(input, { ...env, ...overrides })).toThrow(err)
}

test("removes only target-dependents from approved preview and preserves order", () => {
  const input = args("preview")
  const copy = [...input]
  expect(narrowDevPaymentPulumiArgs(input, env)).toEqual(copy.slice(0, -1))
  expect(input).toEqual(copy)
})

test("removes only target-dependents from approved up and preserves every other arg", () => {
  const input = args("up")
  const output = narrowDevPaymentPulumiArgs(input, env)
  expect(output).toEqual(input.filter((arg) => arg !== "--target-dependents"))
  expect(output).toContain("--yes")
  expect(output).toContain("-f")
})

test("rejects unapproved commands, mutation flags, excludes, and malformed options", () => {
  const base = args("preview")
  const cases = [
    ["refresh command", ["refresh", ...base.slice(1)]],
    ["preview yes", ["preview", "--yes", ...base.slice(1)]],
    ["preview force", ["preview", "-f", ...base.slice(1)]],
    ["up missing yes", args("up").filter((arg) => arg !== "--yes")],
    ["up missing force", args("up").filter((arg) => arg !== "-f")],
    ["unknown flag", [...base, "--show-secrets"]],
    ["exclude", [...base, "--exclude", "urn:pulumi:dev::mongolgpt::sst:cloudflare:x::Console"]],
    ["exclude dependents", [...base, "--exclude-dependents"]],
    ["missing stack value", base.filter((arg) => arg !== "organization/mongolgpt/dev")],
    ["wrong stack", base.map((arg) => (arg === "organization/mongolgpt/dev" ? "organization/mongolgpt/prod" : arg))],
    ["missing non-interactive", base.filter((arg) => arg !== "--non-interactive")],
    ["relative event log", base.map((arg) => (arg === eventLog ? "pulumi-eventlog.json" : arg))],
  ] satisfies Array<[string, string[]]>
  for (const [, input] of cases) rejects(input)
})

test("rejects missing, duplicate, or wrong configs and targets", () => {
  const base = args("preview")
  const without = (value: string) => base.filter((arg) => arg !== value)
  const cases = [
    ["missing cloudflare config", without("cloudflare:version=6.15.0")],
    ["missing random config", without("random:version=4.19.2")],
    ["duplicate config", [...base, "--config", "random:version=4.19.2"]],
    [
      "wrong provider version",
      base.map((arg) => (arg === "cloudflare:version=6.15.0" ? "cloudflare:version=6.16.0" : arg)),
    ],
    ["missing script target", without(scriptUrn)],
    ["missing url target", without(urlUrn)],
    ["duplicate target", [...base, "--target", scriptUrn]],
    ["wrong target", base.map((arg) => (arg === urlUrn ? urlUrn.replace("PaymentServiceUrl", "ConsoleUrl") : arg))],
    ["missing target-dependents", without("--target-dependents")],
    ["duplicate target-dependents", [...base, "--target-dependents"]],
  ] satisfies Array<[string, string[]]>
  for (const [, input] of cases) rejects(input)
})

test("rejects wrong environment and never leaks private args in the error", () => {
  for (const [key, value] of [
    ["CLOUDFLARE_ACCOUNT_ID", "wrong"],
    ["CLOUDFLARE_DEFAULT_ACCOUNT_ID", "wrong"],
    ["MONGOLGPT_DOMAIN", "example.com"],
    ["MONGOLGPT_PAYMENT_ENVIRONMENT", "live"],
    ["MONGOLGPT_ENABLE_REAL_PAYMENTS", "true"],
  ] satisfies Array<[keyof typeof env, string]>) {
    rejects(args("preview"), { [key]: value })
  }
  const secretish = "secret-token-should-not-appear"
  try {
    narrowDevPaymentPulumiArgs([...args("preview"), "--config", `private=${secretish}`], env)
    throw new Error("expected rejection")
  } catch (error) {
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe(err)
    expect((error as Error).message).not.toContain(secretish)
  }
})
