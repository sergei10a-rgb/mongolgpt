import { CloudflareAccessPreflightError, preflightCloudflareAccess } from "@mongolgpt/script/cloudflare-access"
import { DeploymentPreflightError, deploymentEndpoints, preflightDeployment } from "@mongolgpt/script/deployment"

try {
  const result = preflightDeployment({
    stage: process.argv[2] ?? process.env.SST_STAGE ?? "dev",
    env: process.env,
  })
  const access = result.adminEnabled
    ? await preflightCloudflareAccess({
        accountId: process.env.CLOUDFLARE_DEFAULT_ACCOUNT_ID ?? "",
        token: process.env.CLOUDFLARE_ACCESS_API_TOKEN ?? "",
      })
    : undefined
  console.log("Cloudflare deployment preflight амжилттай.")
  console.log(JSON.stringify({ ...result, access, endpoints: deploymentEndpoints(result) }, null, 2))
} catch (error) {
  if (error instanceof DeploymentPreflightError) {
    console.error(error.message)
    process.exit(1)
  }
  if (error instanceof CloudflareAccessPreflightError) {
    console.error(`Cloudflare Access урьдчилсан шалгалт амжилтгүй боллоо: ${error.message}`)
    process.exit(1)
  }
  throw error
}
