import {
  CloudflareDeploymentPreflightError,
  preflightCloudflareDeploymentAccess,
} from "@mongolgpt/script/cloudflare-deployment"

try {
  const result = await preflightCloudflareDeploymentAccess({
    accountId: process.env.CLOUDFLARE_DEFAULT_ACCOUNT_ID ?? "",
    token: process.env.CLOUDFLARE_API_TOKEN ?? "",
    domain: process.env.MONGOLGPT_DOMAIN ?? "",
    scope: process.argv.includes("--runtime-only") ? "runtime-only" : "full",
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
