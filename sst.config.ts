/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  async app(input) {
    const { requireDeploymentStage } = await import("./packages/script/src/deployment-stage.js")
    const stage = requireDeploymentStage(input?.stage)
    const hostedServices = flag("MONGOLGPT_ENABLE_HOSTED_SERVICES")
    const docsOnly = flag("MONGOLGPT_DEPLOY_DOCS_ONLY")
    const appOnly = flag("MONGOLGPT_DEPLOY_APP_ONLY")
    const consoleOnly = flag("MONGOLGPT_DEPLOY_CONSOLE_ONLY")
    const databaseOnly = flag("MONGOLGPT_DEPLOY_DATABASE_ONLY")
    const d1BackupOnly = flag("MONGOLGPT_DEPLOY_D1_BACKUP_ONLY")
    const rootPreviewAlias = flag("MONGOLGPT_ENABLE_ROOT_PREVIEW_ALIAS")
    const admin = flag("MONGOLGPT_ENABLE_ADMIN")
    const d1Backups = flag("MONGOLGPT_ENABLE_D1_BACKUPS")
    const monitoring = flag("MONGOLGPT_ENABLE_MONITORING")
    const analytics = flag("MONGOLGPT_ENABLE_ANALYTICS")
    const cloudflareProviderMigration = flag("MONGOLGPT_CLOUDFLARE_PROVIDER_MIGRATION")
    const cloudflareProviderBridge = flag("MONGOLGPT_CLOUDFLARE_PROVIDER_BRIDGE")
    const unsupported = ["MONGOLGPT_ENABLE_BUSINESS_INTEGRATIONS", "MONGOLGPT_ENABLE_LEGACY_STRIPE"].filter(flag)
    if (unsupported.length) {
      throw new Error(`Cloudflare-д суурилсан байршуулалтын горим дараахыг дэмжихгүй: ${unsupported.join(", ")}`)
    }
    if (docsOnly && stage !== "dev") {
      throw new Error("MONGOLGPT_DEPLOY_DOCS_ONLY-г зөвхөн dev орчинд ашиглана.")
    }
    if (appOnly && stage !== "dev") {
      throw new Error("MONGOLGPT_DEPLOY_APP_ONLY-г зөвхөн dev орчинд ашиглана.")
    }
    if (consoleOnly && stage !== "dev") {
      throw new Error("MONGOLGPT_DEPLOY_CONSOLE_ONLY-г зөвхөн dev орчинд ашиглана.")
    }
    if (d1BackupOnly && stage !== "dev") {
      throw new Error("MONGOLGPT_DEPLOY_D1_BACKUP_ONLY-г зөвхөн dev орчинд ашиглана.")
    }
    if ([docsOnly, appOnly, consoleOnly, d1BackupOnly].filter(Boolean).length > 1) {
      throw new Error(
        "MONGOLGPT_DEPLOY_DOCS_ONLY, MONGOLGPT_DEPLOY_APP_ONLY, MONGOLGPT_DEPLOY_CONSOLE_ONLY, MONGOLGPT_DEPLOY_D1_BACKUP_ONLY-г хамтад нь ашиглахгүй.",
      )
    }
    if (databaseOnly && (docsOnly || appOnly || consoleOnly || d1BackupOnly || cloudflareProviderMigration)) {
      throw new Error("MONGOLGPT_DEPLOY_DATABASE_ONLY-г бусад тусгаарласан deploy горимтой хамтад нь ашиглахгүй.")
    }
    if (databaseOnly && !hostedServices) {
      throw new Error("MONGOLGPT_DEPLOY_DATABASE_ONLY нь hosted services асаалттай байхыг шаардана.")
    }
    if (rootPreviewAlias && (stage !== "dev" || docsOnly || appOnly || databaseOnly || d1BackupOnly)) {
      throw new Error(
        "MONGOLGPT_ENABLE_ROOT_PREVIEW_ALIAS-г зөвхөн үндсэн hosted dev deploy эсвэл console-only dev deploy-д ашиглана.",
      )
    }
    if (rootPreviewAlias && !hostedServices && !consoleOnly) {
      throw new Error(
        "MONGOLGPT_ENABLE_ROOT_PREVIEW_ALIAS-г hosted service эсвэл console-only dev deploy үед л ашиглана.",
      )
    }
    if (appOnly && !hostedServices) {
      throw new Error("MONGOLGPT_DEPLOY_APP_ONLY нь hosted services асаалттай байхыг шаардана.")
    }
    if (consoleOnly && !hostedServices) {
      throw new Error("MONGOLGPT_DEPLOY_CONSOLE_ONLY нь MONGOLGPT_ENABLE_HOSTED_SERVICES=true байхыг шаардана.")
    }
    if (d1BackupOnly && (!hostedServices || !d1Backups)) {
      throw new Error(
        "MONGOLGPT_DEPLOY_D1_BACKUP_ONLY нь MONGOLGPT_ENABLE_HOSTED_SERVICES=true болон MONGOLGPT_ENABLE_D1_BACKUPS=true байхыг шаардана.",
      )
    }
    if (docsOnly && hostedServices) {
      throw new Error("MONGOLGPT_DEPLOY_DOCS_ONLY нь hosted services унтраалттай байхыг шаардана.")
    }
    if (analytics && !hostedServices) {
      throw new Error("MONGOLGPT_ENABLE_ANALYTICS нь MONGOLGPT_ENABLE_HOSTED_SERVICES=true үед л ажиллана.")
    }
    if (admin && !hostedServices) {
      throw new Error("MONGOLGPT_ENABLE_ADMIN нь MONGOLGPT_ENABLE_HOSTED_SERVICES=true үед л ажиллана.")
    }
    if (d1Backups && !hostedServices) {
      throw new Error("MONGOLGPT_ENABLE_D1_BACKUPS нь MONGOLGPT_ENABLE_HOSTED_SERVICES=true үед л ажиллана.")
    }
    if (monitoring && !hostedServices) {
      throw new Error("MONGOLGPT_ENABLE_MONITORING нь MONGOLGPT_ENABLE_HOSTED_SERVICES=true үед л ажиллана.")
    }
    if (cloudflareProviderMigration && (stage !== "dev" || !hostedServices || appOnly)) {
      throw new Error("Cloudflare provider-ийн түр шилжилтийг зөвхөн hosted dev орчинд ажиллуулна.")
    }
    if (cloudflareProviderBridge && (stage !== "dev" || !hostedServices || appOnly || cloudflareProviderMigration)) {
      throw new Error("Cloudflare provider bridge-ийг зөвхөн үндсэн hosted dev deploy-д дангаар нь ашиглана.")
    }
    if (stage === "production" && hostedServices && !admin) {
      throw new Error("Үйлдвэрлэлийн үйлчилгээ байршуулалтад MONGOLGPT_ENABLE_ADMIN=true заавал байна.")
    }
    if (stage === "production" && hostedServices && !d1Backups) {
      throw new Error("Үйлдвэрлэлийн үйлчилгээ байршуулалтад MONGOLGPT_ENABLE_D1_BACKUPS=true заавал байна.")
    }
    if (stage === "production" && hostedServices && !monitoring) {
      throw new Error("Үйлдвэрлэлийн үйлчилгээ байршуулалтад MONGOLGPT_ENABLE_MONITORING=true заавал байна.")
    }
    return {
      name: "mongolgpt",
      removal: stage === "production" ? "retain" : "remove",
      protect: stage === "production",
      home: "cloudflare",
      providers: hostedServices && !appOnly
        ? {
            // Cloudflare v5 state must pass through provider 6.14 (Terraform 5.18) before 6.15+.
            cloudflare: cloudflareProviderMigration ? "6.14.0" : "6.15.0",
            random: "4.19.2",
            ...(admin ? { command: "1.0.1" } : {}),
          }
        : {},
    }
  },
  async run() {
    const stage = await import("./infra/stage.js")
    const hostedServices = flag("MONGOLGPT_ENABLE_HOSTED_SERVICES")
    const docsOnly = flag("MONGOLGPT_DEPLOY_DOCS_ONLY")
    const appOnly = flag("MONGOLGPT_DEPLOY_APP_ONLY")
    const consoleOnly = flag("MONGOLGPT_DEPLOY_CONSOLE_ONLY")
    const databaseOnly = flag("MONGOLGPT_DEPLOY_DATABASE_ONLY")
    const d1BackupOnly = flag("MONGOLGPT_DEPLOY_D1_BACKUP_ONLY")
    const cloudflareProviderMigration = flag("MONGOLGPT_CLOUDFLARE_PROVIDER_MIGRATION")
    const cloudflareProviderBridge = flag("MONGOLGPT_CLOUDFLARE_PROVIDER_BRIDGE")
    const adminEnabled = stage.enableAdmin
    if (cloudflareProviderMigration) {
      const queues = await import("./infra/cloudflare-provider-migration.js")
      return {
        CloudflareProviderMigration: true,
        UsageDeadLetterQueue: queues.usageDeadLetterQueue.nodes.queue.queueName,
        UsageQueue: queues.usageQueue.nodes.queue.queueName,
      }
    }
    if (cloudflareProviderBridge) {
      const cloudflare = await import("@pulumi/cloudflare")
      new cloudflare.Provider("default_6_14_0", {}, { version: "6.14.0" })
    }
    if (databaseOnly) {
      const { database } = await import("./infra/database.js")
      return {
        Database: database.databaseId,
        HostedServices: true,
      }
    }
    if (d1BackupOnly) {
      const backup = await import("./infra/console.js")
      if (!backup.d1BackupWorkflow || !backup.d1BackupSchedule) {
        throw new Error("Dev D1 нөөцлөлтийн Workflow болон Cron үүссэнгүй.")
      }
      return {
        Database: backup.database.databaseId,
        D1Backups: backup.d1Backups.name,
        D1BackupWorkflowName: backup.d1BackupWorkflow.workflowName,
        HostedServices: true,
      }
    }
    if (docsOnly) {
      const docs = await import("./infra/docs.js")
      return {
        DocsUrl: docs.docsUrl,
        DocsWorkerUrl: docs.website.url,
        HostedServices: false,
      }
    }
    if (appOnly) {
      const site = await import("./infra/web-app.js")
      return {
        WebAppUrl: site.webApp.url,
        HostedServices: true,
      }
    }
    if (consoleOnly) {
      const site = await import("./infra/console.js")
      return {
        ConsoleUrl: site.consoleApp.url,
        HostedServices: true,
      }
    }
    const site = await import("./infra/site.js")
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
    const admin = adminEnabled ? await import("./infra/admin.js") : undefined
    const stats = stage.enableAnalytics ? await import("./infra/stats.js") : undefined
    const enterprise = stage.enableShareService ? await import("./infra/enterprise.js") : undefined
    return {
      StatWorkerUrl: stat.url,
      StatsUrl: stats?.app.url ?? "",
      WebsiteUrl: consoleApp.url,
      PaymentServiceUrl: paymentService.url,
      DocsUrl: site.docsUrl,
      DocsWorkerUrl: site.website.url,
      WebAppUrl: site.webApp.url,
      ShareUrl: enterprise?.teams.url ?? "",
      AdminUrl: admin?.adminUrl ?? "",
      HostedServices: true,
    }
  },
})

function flag(name: string) {
  const value = process.env[name]
  if (value === undefined || value === "") return false
  if (value !== "true" && value !== "false") throw new Error(`${name} нь зөвхөн true эсвэл false байна.`)
  return value === "true"
}
