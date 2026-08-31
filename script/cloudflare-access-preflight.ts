import { CloudflareAccessPreflightError, preflightCloudflareAccess } from "@mongolgpt/script/cloudflare-access"

try {
  await preflightCloudflareAccess({
    accountId: process.env.CLOUDFLARE_DEFAULT_ACCOUNT_ID ?? "",
    token: process.env.CLOUDFLARE_ACCESS_API_TOKEN ?? "",
  })
  console.log("Cloudflare Access token-ийн урьдчилсан шалгалт амжилттай.")
} catch (error) {
  if (error instanceof CloudflareAccessPreflightError) {
    console.error(`Cloudflare Access token-ийн урьдчилсан шалгалт амжилтгүй боллоо: ${error.message}`)
    process.exit(1)
  }
  throw error
}
