import { verifyDevPaymentHealth } from "../packages/script/src/payment-service-live-check"

try {
  const phase = process.argv[2]
  if (process.argv.length !== 3 || (phase !== "before" && phase !== "after")) throw new Error("Invalid phase")
  console.log(JSON.stringify(await verifyDevPaymentHealth(phase)))
} catch {
  console.error("Disabled dev payment verification failed; response bodies and private details were not printed.")
  process.exit(1)
}
