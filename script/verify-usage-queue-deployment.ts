import { verifyUsageQueueDeploymentDiff } from "../packages/script/src/usage-queue-deployment-guard"

try {
  if (process.argv.length !== 3) throw new Error("Missing private diff")
  const file = Bun.file(process.argv[2])
  if (!(await file.exists()) || file.size > 16 * 1024 * 1024) throw new Error("Invalid private diff")
  console.log(JSON.stringify(verifyUsageQueueDeploymentDiff(await file.json())))
} catch {
  console.error("Dev queue deployment rejected; private diff content was not printed.")
  process.exit(1)
}
