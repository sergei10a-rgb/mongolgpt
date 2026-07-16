const rootDomain = process.env.MONGOLGPT_DOMAIN?.trim()
if (!rootDomain) throw new Error("MONGOLGPT_DOMAIN is required for infrastructure deployment")

export const domain = $app.stage === "production" ? rootDomain : `${$app.stage}.${rootDomain}`
export const awsStage = $app.stage === "production" ? "production" : "dev"
export const deployAws = $app.stage === awsStage

export const publicOrigin = `https://${domain}`
export const docsOrigin = `https://docs.${domain}`
export const shareOrigin = `https://share.${domain}`
