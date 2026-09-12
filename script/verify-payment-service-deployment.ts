import {
  PaymentServiceDeploymentGuardError,
  verifyPaymentServiceDeploymentDiff,
} from "../packages/script/src/usage-queue-deployment-guard"

try {
  if (process.argv.length !== 3) throw new PaymentServiceDeploymentGuardError()
  const file = Bun.file(process.argv[2])
  if (!(await file.exists()) || file.size > 16 * 1024 * 1024) throw new PaymentServiceDeploymentGuardError()
  console.log(JSON.stringify(verifyPaymentServiceDeploymentDiff(await file.json())))
} catch (error) {
  console.error("Dev payment service deployment rejected; private diff content was not printed.")
  console.error(
    JSON.stringify({
      approved: false,
      reason: error instanceof PaymentServiceDeploymentGuardError ? error.reason : "invalid-preview",
    }),
  )
  process.exit(1)
}
