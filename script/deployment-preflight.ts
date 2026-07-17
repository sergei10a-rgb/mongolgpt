import { DeploymentPreflightError, deploymentEndpoints, preflightDeployment } from "@mongolgpt/script/deployment"

try {
  const result = preflightDeployment({
    stage: process.argv[2] ?? process.env.SST_STAGE ?? "dev",
    env: process.env,
  })
  console.log("Cloudflare deployment preflight амжилттай.")
  console.log(JSON.stringify({ ...result, endpoints: deploymentEndpoints(result) }, null, 2))
} catch (error) {
  if (error instanceof DeploymentPreflightError) {
    console.error(error.message)
    process.exit(1)
  }
  throw error
}
