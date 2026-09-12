import { open } from "node:fs/promises"
import { constants } from "node:fs"
import { paymentPulumiStatuses } from "../packages/script/src/payment-service-pulumi-args"
import { inspectSstCommandErrorDiagnostics } from "../packages/script/src/sst-error-diagnostics"

const receiptLimit = 1024
const logLimit = 16 * 1024 * 1024
const statuses = new Set<string>(paymentPulumiStatuses)

type Status = (typeof paymentPulumiStatuses)[number] | "unavailable"
type Sst = "target-not-found" | "scope-flag-conflict" | "unclassified" | "unreadable"

async function readRegularFile(path: string, limit: number): Promise<string | undefined> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > limit) return undefined
      const buffer = Buffer.alloc(stat.size)
      let offset = 0
      while (offset < buffer.length) {
        const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset)
        if (!bytesRead) return undefined
        offset += bytesRead
      }
      if ((await file.stat()).size !== stat.size) return undefined
      return buffer.toString("utf8")
    } finally {
      await file.close()
    }
  } catch {
    return undefined
  }
}

function statusFromReceipt(receipt: string | undefined): Status {
  if (receipt === undefined || receipt.length === 0) return "unavailable"
  try {
    const parsed: unknown = JSON.parse(receipt)
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof (parsed as { status?: unknown }).status === "string" &&
      statuses.has((parsed as { status: string }).status)
    ) {
      return (parsed as { status: Status }).status
    }
  } catch {
    return "unavailable"
  }
  return "unavailable"
}

function classifySst(stdout: string | undefined, stderr: string | undefined): Sst {
  if (stdout === undefined || stderr === undefined) return "unreadable"
  const logs = `${stdout}\n${stderr}`
  if (logs.includes("Target not found:")) return "target-not-found"
  if (logs.includes("flags in the group [target exclude]")) return "scope-flag-conflict"
  return "unclassified"
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length !== 3 && args.length !== 5) {
    process.stdout.write(JSON.stringify({ status: "unavailable", sst: "unreadable" satisfies Sst }))
    return
  }

  const [receiptPath, stdoutPath, stderrPath] = args
  const [receipt, stdout, stderr] = await Promise.all([
    readRegularFile(receiptPath, receiptLimit),
    readRegularFile(stdoutPath, logLimit),
    readRegularFile(stderrPath, logLimit),
  ])

  const native = args.length === 5 ? await classifyNative(args.slice(3)) : undefined
  process.stdout.write(
    JSON.stringify({
      status: statusFromReceipt(receipt),
      sst: classifySst(stdout, stderr),
      ...(native ? { native } : {}),
    }),
  )
}

async function classifyNative(paths: string[]) {
  const secrets = Object.entries(process.env).flatMap(([name, value]) =>
    /(credential|key|password|secret|token)/i.test(name) && value ? [value] : [],
  )
  const logs = await Promise.all(paths.map((path) => readRegularFile(path, logLimit)))
  const messages = logs.flatMap((log) =>
    log === undefined ? [] : inspectSstCommandErrorDiagnostics(log, secrets).map((item) => item.message),
  )
  // Only fixed labels escape this boundary, never even sanitized free-form native messages.
  const signatures = [
    // Pulumi v3.215.0 sdk/go/common/diag/errors.go, diagnostics 2010, 2013 and 2014.
    ["omitted-dependency-create", /which was was not specified in --target list\./],
    ["omitted-dependent-destroy", /will be destroyed but was not specified in --target list\./],
    ["native-target-not-found", /could not be found in the stack\./],
    ["module-resolution", /Cannot find module|ERR_MODULE_NOT_FOUND|Could not resolve/],
    ["javascript-exception", /(?:ReferenceError|TypeError|SyntaxError):/],
    ["authentication", /Authentication error|Unauthorized|HTTP 401|status code: 401/],
    ["permission", /Forbidden|HTTP 403|status code: 403|permission denied/i],
    ["rate-limit", /Too Many Requests|HTTP 429|status code: 429/],
    ["snapshot-integrity", /snapshot integrity/i],
  ] as const
  return {
    readableFiles: logs.filter((log) => log !== undefined).length,
    errorCount: messages.length,
    categories: signatures.flatMap(([label, pattern]) =>
      messages.some((message) => pattern.test(message)) ? [label] : [],
    ),
  }
}

await main().catch(() => {
  console.log(JSON.stringify({ status: "unavailable", sst: "unreadable" }))
})
