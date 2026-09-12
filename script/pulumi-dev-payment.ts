import { execFileSync } from "node:child_process"
import { isAbsolute, join } from "node:path"
import { lstat, open } from "node:fs/promises"
import { constants } from "node:fs"
import {
  narrowDevPaymentPulumiArgs,
  PaymentPulumiInvocationError,
  paymentPulumiStatuses,
} from "../packages/script/src/payment-service-pulumi-args"

let status: (typeof paymentPulumiStatuses)[number] = "started"
const reportPath = process.env.MONGOLGPT_PAYMENT_DIAGNOSTIC_FILE
const report = async () => {
  if (!reportPath) return
  if (!isAbsolute(reportPath) || !(await lstat(reportPath)).isFile()) throw new Error("invalid-diagnostic-file")
  const file = await open(reportPath, constants.O_WRONLY | constants.O_NOFOLLOW)
  try {
    if (!(await file.stat()).isFile()) throw new Error("invalid-diagnostic-file")
    await file.truncate()
    await file.writeFile(JSON.stringify({ status }))
  } finally {
    await file.close()
  }
}

try {
  await report()
  const args = narrowDevPaymentPulumiArgs(process.argv.slice(2), process.env)
  status = "arguments-approved"
  await report()
  const home = process.env.PULUMI_HOME
  status = "runtime-home"
  if (!home || !isAbsolute(home)) throw new Error("invalid-runtime")
  const binary = join(home, "bin", process.platform === "win32" ? "pulumi.exe" : "pulumi")
  status = "runtime-file"
  if (!(await lstat(binary)).isFile()) throw new Error("invalid-runtime")
  status = "runtime-version-check"
  const version = execFileSync(binary, ["version"], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()
  status = "runtime-version"
  if (version !== "v3.215.0") throw new Error("invalid-runtime")
  status = "runtime-launch"
  await report()
  const child = Bun.spawn([binary, ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  let forced: ReturnType<typeof setTimeout> | undefined
  const stop = () => {
    child.kill("SIGTERM")
    forced ??= setTimeout(() => child.kill("SIGKILL"), 5_000)
  }
  const deadline = setTimeout(stop, 10 * 60_000)
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
  try {
    status = "native-running"
    await report()
    process.exitCode = await child.exited
    status = process.exitCode === 0 ? "native-completed" : "native-failed"
    await report()
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGKILL")
      await child.exited
    }
    clearTimeout(deadline)
    clearTimeout(forced)
    process.off("SIGINT", stop)
    process.off("SIGTERM", stop)
  }
} catch (error) {
  if (error instanceof PaymentPulumiInvocationError) status = error.status
  await report().catch(() => {})
  console.error("Dev payment Pulumi invocation is not approved")
  process.exitCode = 1
}
