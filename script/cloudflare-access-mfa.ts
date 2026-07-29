import { CloudflareAccessPreflightError, configureCloudflareAccessMfa } from "@mongolgpt/script/cloudflare-access"

try {
  const result = await configureCloudflareAccessMfa({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
    token: process.env.CLOUDFLARE_ACCESS_API_TOKEN ?? "",
  })
  console.log(`Cloudflare Access Independent MFA бэлэн: ${result.teamDomain}`)
} catch (error) {
  if (error instanceof CloudflareAccessPreflightError) {
    console.error(`Cloudflare Access MFA тохиргоо амжилтгүй боллоо: ${error.message}`)
    process.exit(1)
  }
  throw error
}
