sst.Linkable.wrap(random.RandomPassword, (resource) => ({
  properties: {
    value: resource.result,
  },
}))

const byokCredentialsKeyV1 = process.env.BYOK_CREDENTIALS_KEY_V1?.trim()
if (!byokCredentialsKeyV1 || byokCredentialsKeyV1.length < 32) {
  throw new Error("BYOK_CREDENTIALS_KEY_V1 must contain at least 32 characters.")
}

export const SECRET = {
  R2AccessKey: new sst.Secret("R2AccessKey", "unknown"),
  R2SecretKey: new sst.Secret("R2SecretKey", "unknown"),
  HoneycombApiKey: new sst.Secret("HONEYCOMB_API_KEY", "disabled"),
  HoneycombWebhookSecret: new random.RandomPassword("HoneycombWebhookSecret", { length: 24 }),
  SupportApiKey: new sst.Secret("SUPPORT_API_KEY", "disabled"),
  QuotaServiceToken: new random.RandomPassword("QuotaServiceToken", { length: 48 }),
  ByokCredentialsKeyV1: new sst.Secret("ByokCredentialsKeyV1", byokCredentialsKeyV1),
}
