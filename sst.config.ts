/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    const hostedServices = flag("MONGOLGPT_ENABLE_HOSTED_SERVICES")
    const monitoring = hostedServices && flag("MONGOLGPT_ENABLE_MONITORING")
    const analytics = flag("MONGOLGPT_ENABLE_ANALYTICS")
    const unsupported = ["MONGOLGPT_ENABLE_BUSINESS_INTEGRATIONS", "MONGOLGPT_ENABLE_LEGACY_STRIPE"].filter(flag)
    if (unsupported.length) {
      throw new Error(`Cloudflare-only launch profile does not support: ${unsupported.join(", ")}`)
    }
    if (analytics && !hostedServices) {
      throw new Error("MONGOLGPT_ENABLE_ANALYTICS requires MONGOLGPT_ENABLE_HOSTED_SERVICES=true.")
    }
    return {
      name: "mongolgpt",
      removal: input?.stage === "production" ? "retain" : "remove",
      protect: ["production"].includes(input?.stage),
      home: "cloudflare",
      providers: hostedServices
        ? {
            random: "4.19.2",
            ...(monitoring ? { honeycomb: "0.49.0" } : {}),
          }
        : {},
    }
  },
  async run() {
    const stage = await import("./infra/stage.js")
    const site = await import("./infra/site.js")
    const hostedServices = flag("MONGOLGPT_ENABLE_HOSTED_SERVICES")
    if (!hostedServices) {
      return {
        DocsUrl: site.docsUrl,
        DocsWorkerUrl: site.website.url,
        StatsUrl: "",
        WebAppUrl: site.webApp.url,
        HostedServices: false,
      }
    }

    if (stage.enableSyncService) await import("./infra/app.js")
    const { consoleApp, paymentService, stat } = await import("./infra/console.js")
    const stats = stage.enableAnalytics ? await import("./infra/stats.js") : undefined
    const enterprise = stage.enableShareService ? await import("./infra/enterprise.js") : undefined
    if (stage.enableMonitoring && ($app.stage === "production" || $app.stage === "vimtor")) {
      await import("./infra/monitoring.js")
    }

    return {
      StatWorkerUrl: stat.url,
      StatsUrl: stats?.app.url ?? "",
      WebsiteUrl: consoleApp.url,
      PaymentServiceUrl: paymentService.url,
      DocsUrl: site.docsUrl,
      DocsWorkerUrl: site.website.url,
      WebAppUrl: site.webApp.url,
      ShareUrl: enterprise?.teams.url ?? "",
      HostedServices: true,
    }
  },
})

function flag(name: string) {
  const value = process.env[name]
  if (value === undefined || value === "") return false
  if (value !== "true" && value !== "false") throw new Error(`${name} must be exactly true or false.`)
  return value === "true"
}
