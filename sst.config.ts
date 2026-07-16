/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    const hostedServices = process.env.MONGOLGPT_ENABLE_HOSTED_SERVICES === "true"
    return {
      name: "mongolgpt",
      removal: input?.stage === "production" ? "retain" : "remove",
      protect: ["production"].includes(input?.stage),
      home: "cloudflare",
      providers: hostedServices
        ? {
            aws: {
              version: "7.30.0",
              region: "us-east-1",
              profile: process.env.GITHUB_ACTIONS
                ? undefined
                : input.stage === "production"
                  ? "mongolgpt-production"
                  : "mongolgpt-dev",
            },
            stripe: {
              version: "0.0.28",
              apiKey: process.env.STRIPE_SECRET_KEY!,
            },
            random: "4.19.2",
            planetscale: "0.4.1",
            honeycomb: "0.49.0",
          }
        : {},
    }
  },
  async run() {
    const stage = await import("./infra/stage.js")
    const site = await import("./infra/site.js")
    const hostedServices = process.env.MONGOLGPT_ENABLE_HOSTED_SERVICES === "true"
    if (!hostedServices) {
      return {
        DocsUrl: site.docsUrl,
        DocsWorkerUrl: site.website.url,
        WebAppUrl: site.webApp.url,
        HostedServices: false,
      }
    }

    await import("./infra/app.js")
    const lake = stage.deployAws ? await import("./infra/lake.js") : undefined
    const stats = stage.deployAws ? await import("./infra/stats.js") : undefined
    const { consoleApp, stat } = await import("./infra/console.js")
    const { teams } = await import("./infra/enterprise.js")
    if ($app.stage === "production" || $app.stage === "vimtor") {
      await import("./infra/monitoring.js")
    }

    return {
      StatWorkerUrl: stat.url,
      ...(stats ? { StatsUrl: stats.app.url } : {}),
      ...(lake
        ? {
            LakeUrl: lake.lakeIngest.properties.url,
            LakeSecretSsm: lake.ingestSecretSsm.name,
          }
        : {}),
      AwsStage: stage.awsStage,
      WebsiteUrl: consoleApp.url,
      DocsUrl: site.docsUrl,
      DocsWorkerUrl: site.website.url,
      WebAppUrl: site.webApp.url,
      ShareUrl: teams.url,
      HostedServices: true,
    }
  },
})
