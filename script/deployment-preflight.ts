import { CloudflareAccessPreflightError, preflightCloudflareAccess } from "@mongolgpt/script/cloudflare-access"
import {
  CloudflareDeploymentPreflightError,
  preflightCloudflareDeploymentAccess,
} from "@mongolgpt/script/cloudflare-deployment"
import { DeploymentPreflightError, deploymentEndpoints, preflightDeployment } from "@mongolgpt/script/deployment"

try {
  const authBootstrap = process.argv.includes("--auth-bootstrap")
  const docsOnly = process.argv.includes("--docs-only")
  const appOnly = process.argv.includes("--app-only")
  const runtimeOnly = process.argv.includes("--runtime-only")
  if ([authBootstrap, docsOnly, appOnly, runtimeOnly].filter(Boolean).length > 1) {
    throw new DeploymentPreflightError([
      "--auth-bootstrap, --docs-only, --app-only, --runtime-only scope-үүдийг хамтад нь ашиглахгүй.",
    ])
  }
  const scope = authBootstrap
    ? "auth-bootstrap"
    : docsOnly
      ? "docs-only"
      : appOnly
        ? "app-only"
        : runtimeOnly
          ? "runtime-only"
          : "full"
  const result = preflightDeployment({
    stage: process.argv[2] ?? process.env.SST_STAGE ?? "dev",
    env: process.env,
    requireHostedServices: scope !== "docs-only",
    requireDeploymentSecrets: scope === "app-only" ? false : undefined,
    scope,
  })
  const cloudflare = await preflightCloudflareDeploymentAccess({
    accountId: process.env.CLOUDFLARE_DEFAULT_ACCOUNT_ID ?? "",
    token: process.env.CLOUDFLARE_API_TOKEN ?? "",
    domain: result.domain,
    scope:
      scope === "docs-only" || scope === "app-only"
        ? "worker-only"
        : scope === "auth-bootstrap"
          ? "hosted-only"
          : scope === "runtime-only"
            ? "runtime-only"
            : "full",
  })
  const access = result.adminEnabled
    ? await preflightCloudflareAccess({
        accountId: process.env.CLOUDFLARE_DEFAULT_ACCOUNT_ID ?? "",
        token: process.env.CLOUDFLARE_ACCESS_API_TOKEN ?? "",
      })
    : undefined
  console.log("Cloudflare deployment preflight амжилттай.")
  console.log(JSON.stringify({ ...result, cloudflare, access, endpoints: deploymentEndpoints(result) }, null, 2))
} catch (error) {
  if (error instanceof DeploymentPreflightError) {
    console.error(error.message)
    process.exit(1)
  }
  if (error instanceof CloudflareAccessPreflightError) {
    console.error(`Cloudflare Access урьдчилсан шалгалт амжилтгүй боллоо: ${error.message}`)
    process.exit(1)
  }
  if (error instanceof CloudflareDeploymentPreflightError) {
    console.error(`Cloudflare deploy token-ийн урьдчилсан шалгалт амжилтгүй боллоо: ${error.message}`)
    process.exit(1)
  }
  throw error
}
