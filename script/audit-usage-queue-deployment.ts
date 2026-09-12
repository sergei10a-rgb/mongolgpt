import { summarizeUsageQueueDeploymentDiff } from "../packages/script/src/usage-queue-deployment-audit"

try {
  const path = process.argv[2]
  if (!path || process.argv.length !== 3) throw new Error("Missing audit file")
  const file = Bun.file(path)
  if (!(await file.exists()) || file.size > 16 * 1024 * 1024) throw new Error("Invalid audit file")
  console.log(JSON.stringify(summarizeUsageQueueDeploymentDiff(await file.json()), null, 2))
} catch {
  console.error("Dev usage queue deployment audit failed; private diff content was not printed.")
  process.exit(1)
}
