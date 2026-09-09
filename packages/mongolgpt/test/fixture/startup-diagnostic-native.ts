import { CloudStartup } from "@mongolgpt/core/database/cloud-startup"
import { startupDiagnosticEnv } from "@mongolgpt/runtime-auth/startup-diagnostic"
import { reportStartupFailure } from "../../src/cli/startup-diagnostic"

const config = JSON.parse(await Bun.stdin.text()) as {
  origin: string
  token: string
  admin: string
  missingRoot: string
}
if (new URL(config.origin).hostname !== "127.0.0.1") throw new Error("Loopback test only")
process.env[startupDiagnosticEnv] = "true"
const error = await CloudStartup.bootstrap({
  root: config.missingRoot,
  request: async () => {
    throw new Error("Missing root must fail before network")
  },
}).catch((error: unknown) => error)
if (!(error instanceof CloudStartup.StartupError) || error.phase !== "validate_root" || error.code !== "ENOENT")
  throw new Error("Expected actual missing-root startup failure")
let reported = false
await reportStartupFailure(error, config.token, async (request) => {
  const url = new URL(request.url)
  if (url.origin !== "http://checkpoint.mongolgpt.internal" || url.pathname !== "/v1/startup-diagnostic")
    throw new Error("Unexpected diagnostic destination")
  const forwarded = new Request(`${config.origin}${url.pathname}`, request)
  forwarded.headers.set("x-test-admin-token", config.admin)
  const response = await fetch(forwarded)
  reported = response.status === 204
  return response
})
if (!reported) throw new Error("Startup failure not retained")
console.log(JSON.stringify({ reported: true, phase: error.phase, code: error.code }))
