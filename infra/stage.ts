import { resolveHostedServiceUrls } from "@mongolgpt/account-contract/service-urls"

export const rootDomain = process.env.MONGOLGPT_DOMAIN?.trim()
if (!rootDomain) throw new Error("Дэд бүтцийг байршуулахад MONGOLGPT_DOMAIN заавал байна")

const serviceUrls = resolveHostedServiceUrls(rootDomain, $app.stage)

export const domain = serviceUrls.stageDomain
export const enableBusinessIntegrations = process.env.MONGOLGPT_ENABLE_BUSINESS_INTEGRATIONS === "true"
export const enableAnalytics = process.env.MONGOLGPT_ENABLE_ANALYTICS === "true"
export const enableD1Backups = process.env.MONGOLGPT_ENABLE_D1_BACKUPS === "true"
export const enableMonitoring = process.env.MONGOLGPT_ENABLE_MONITORING === "true"
export const enableRootPreviewAlias = process.env.MONGOLGPT_ENABLE_ROOT_PREVIEW_ALIAS === "true"
export const enableTurnstile = process.env.MONGOLGPT_ENABLE_TURNSTILE === "true"
export const enableShareService = process.env.MONGOLGPT_ENABLE_SHARE_SERVICE === "true"
export const enableSyncService = process.env.MONGOLGPT_ENABLE_SYNC_SERVICE === "true"
export const enableAdmin = process.env.MONGOLGPT_ENABLE_ADMIN === "true"

export const publicOrigin = serviceUrls.console
export const appOrigin = serviceUrls.app
export const docsOrigin = serviceUrls.docs
export const runtimeOrigin = serviceUrls.runtime
export const paymentOrigin = serviceUrls.payment
export const shareOrigin = serviceUrls.share
export const adminOrigin = serviceUrls.admin
