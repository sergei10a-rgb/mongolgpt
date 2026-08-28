import {
  CloudflareDeploymentPreflightError,
  preflightCloudflareDeploymentAccess,
} from "@mongolgpt/script/cloudflare-deployment"

try {
  const authBootstrap = process.argv.includes("--auth-bootstrap")
  const runtimeOnly = process.argv.includes("--runtime-only")
  if (authBootstrap && runtimeOnly) {
    throw new CloudflareDeploymentPreflightError(
      "--auth-bootstrap болон --runtime-only Cloudflare scope-ийг хамтад нь ашиглахгүй.",
    )
  }
  const result = await preflightCloudflareDeploymentAccess({
    accountId: process.env.CLOUDFLARE_DEFAULT_ACCOUNT_ID ?? "",
    token: process.env.CLOUDFLARE_API_TOKEN ?? "",
    domain: process.env.MONGOLGPT_DOMAIN ?? "",
    scope: authBootstrap ? "hosted-only" : runtimeOnly ? "runtime-only" : "full",
  })
  console.log("Cloudflare deploy token-ийн урьдчилсан шалгалт амжилттай.")
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  if (error instanceof CloudflareDeploymentPreflightError) {
    console.error(`Cloudflare deploy token-ийн урьдчилсан шалгалт амжилтгүй боллоо: ${error.message}`)
    process.exit(1)
  }
  throw error
}
