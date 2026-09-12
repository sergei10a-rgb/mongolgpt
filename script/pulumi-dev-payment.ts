import { execFileSync } from "node:child_process"
import { isAbsolute, join } from "node:path"
import { lstat } from "node:fs/promises"
import { narrowDevPaymentPulumiArgs } from "../packages/script/src/payment-service-pulumi-args"

try {
  const args = narrowDevPaymentPulumiArgs(process.argv.slice(2), process.env)
  const home = process.env.PULUMI_HOME
  if (!home || !isAbsolute(home)) throw new Error("invalid-runtime")
  const binary = join(home, "bin", process.platform === "win32" ? "pulumi.exe" : "pulumi")
  if (!(await lstat(binary)).isFile()) throw new Error("invalid-runtime")
  const version = execFileSync(binary, ["version"], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()
  if (version !== "v3.215.0") throw new Error("invalid-runtime")
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
    process.exitCode = await child.exited
  } finally {
    clearTimeout(deadline)
    clearTimeout(forced)
    process.off("SIGINT", stop)
    process.off("SIGTERM", stop)
  }
} catch {
  console.error("Dev payment Pulumi invocation is not approved")
  process.exitCode = 1
}
