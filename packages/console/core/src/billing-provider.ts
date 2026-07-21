type BillingEnvironment = Record<string, string | undefined>

export function legacyStripeEnabled(_env: BillingEnvironment = process.env) {
  return false
}

export function assertLegacyStripeEnabled(_env: BillingEnvironment = process.env): never {
  throw new Error("Legacy Stripe billing is permanently disabled in MongolGPT")
}
