import { CloudflareAccessPreflightError, verifyCloudflareAdminAccess } from "@mongolgpt/script/cloudflare-access"

const stage = process.argv[2]?.trim()
const domain = process.env.MONGOLGPT_DOMAIN?.trim().toLowerCase()
if (stage !== "dev" || !domain) {
  console.error("Admin Access баталгаажуулалтыг зөвхөн MONGOLGPT_DOMAIN тохируулсан dev орчинд ажиллуулна.")
  process.exit(1)
}

try {
  const result = await verifyCloudflareAdminAccess({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
    token: process.env.CLOUDFLARE_ACCESS_API_TOKEN ?? "",
    hostname: `admin.${stage}.${domain}`,
    stage,
    bootstrapEmails: process.env.SST_SECRET_MongolGPTAdminBootstrapEmails ?? "",
  })
  console.log(
    `Cloudflare Access admin app, allow policy болон MFA баталгаажлаа: ${result.hostname}, ${result.bootstrapEmailCount} админ.`,
  )
} catch (error) {
  if (error instanceof CloudflareAccessPreflightError) {
    console.error(`Cloudflare Access admin тохиргоо амжилтгүй боллоо: ${error.message}`)
    process.exit(1)
  }
  throw error
}
