const rootDomain = process.env.MONGOLGPT_DOMAIN?.trim()
if (!rootDomain) throw new Error("MONGOLGPT_DOMAIN is required for infrastructure deployment")

export const domain = $app.stage === "production" ? rootDomain : `${$app.stage}.${rootDomain}`
export const enableBusinessIntegrations = process.env.MONGOLGPT_ENABLE_BUSINESS_INTEGRATIONS === "true"
export const enableAnalytics = process.env.MONGOLGPT_ENABLE_ANALYTICS === "true"
export const enableMonitoring = process.env.MONGOLGPT_ENABLE_MONITORING === "true"
export const enableShareService = process.env.MONGOLGPT_ENABLE_SHARE_SERVICE === "true"
export const enableSyncService = process.env.MONGOLGPT_ENABLE_SYNC_SERVICE === "true"

export const publicOrigin = `https://${domain}`
export const appOrigin = `https://app.${domain}`
export const docsOrigin = `https://docs.${domain}/docs`
export const runtimeOrigin = `https://runtime.${domain}`
export const shareOrigin = `https://share.${domain}`
