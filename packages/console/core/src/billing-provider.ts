type BillingEnvironment = Record<string, string | undefined>

export function legacyStripeEnabled(env: BillingEnvironment = process.env) {
  return env.MONGOLGPT_BILLING_PROVIDER === "stripe"
}

export function assertLegacyStripeEnabled(env: BillingEnvironment = process.env) {
  if (!legacyStripeEnabled(env)) throw new Error("Legacy Stripe billing is disabled")
}
