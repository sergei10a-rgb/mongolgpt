import { resolveHostedServiceUrls } from "@mongolgpt/account-contract/service-urls"
import { requireDeploymentStage } from "./deployment-stage"

export function deploymentServiceUrlOutputs(rootDomain: string, stageInput: string) {
  const stage = requireDeploymentStage(stageInput)
  const urls = resolveHostedServiceUrls(rootDomain, stage)
  return {
    channel: stage === "production" ? "prod" : stage === "dev" ? "dev" : "beta",
    app_url: urls.app,
    public_url: urls.console,
    runtime_url: urls.runtime,
    payment_url: urls.payment,
  } as const
}

export function serializeGitHubOutputs(values: ReturnType<typeof deploymentServiceUrlOutputs>) {
  return Object.entries(values)
    .map(([name, value]) => {
      if (!/^[a-z_]+$/.test(name) || value.includes("\n") || value.includes("\r")) {
        throw new Error("GitHub Actions service URL output хүчинтэй биш байна.")
      }
      return `${name}=${value}`
    })
    .join("\n")
}
