import {
  ConsoleUiDeploymentGuardError,
  verifyConsoleUiDeploymentDiff,
} from "../packages/script/src/console-ui-deployment-guard"

try {
  if (process.argv.length !== 3) throw new ConsoleUiDeploymentGuardError()
  const file = Bun.file(process.argv[2])
  if (!(await file.exists()) || file.size > 16 * 1024 * 1024) throw new ConsoleUiDeploymentGuardError()
  console.log(JSON.stringify(verifyConsoleUiDeploymentDiff(await file.json())))
} catch (error) {
  console.error("Dev Console UI deployment rejected; private diff content was not printed.")
  console.error(
    JSON.stringify({
      approved: false,
      reason: error instanceof ConsoleUiDeploymentGuardError ? error.reason : "invalid-preview",
    }),
  )
  process.exit(1)
}
