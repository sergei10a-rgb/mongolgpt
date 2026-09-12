import { verifyDevUsageQueueHeartbeat } from "../packages/script/src/usage-queue-live-check"

try {
  if (process.argv.length !== 3 || !/^\d{13}$/.test(process.argv[2])) throw new Error("Invalid deployment timestamp")
  console.log(
    JSON.stringify(
      await verifyDevUsageQueueHeartbeat({
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
        token: process.env.CLOUDFLARE_API_TOKEN ?? "",
        notBefore: Number(process.argv[2]),
      }),
    ),
  )
} catch {
  console.error("Fresh dev queue heartbeat verification failed; credentials and response bodies were not printed.")
  process.exit(1)
}
