/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  async app(input) {
    const { requireDeploymentStage } = await import("./packages/script/src/deployment-stage.js")
    const stage = requireDeploymentStage(input?.stage)
    if (stage !== "dev") throw new Error("Тусгаарласан admin stack-ийг одоогоор зөвхөн dev орчинд ашиглана.")
    return {
      name: "mongolgpt-admin",
      home: "cloudflare",
      removal: "retain",
      protect: true,
      providers: {
        cloudflare: "6.15.0",
        command: "1.0.1",
      },
    }
  },
  async run() {
    const site = await import("./infra/admin-standalone.js")
    return {
      AdminUrl: site.adminUrl,
      HostedServices: true,
    }
  },
})
