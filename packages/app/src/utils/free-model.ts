import type { Model } from "@mongolgpt/sdk/v2"

type Cost = Model["cost"]
type FreeModel = Pick<Model, "id" | "providerID" | "api" | "status"> & { cost?: Cost }

function zeroCost(cost: Cost | undefined): boolean {
  return !!cost && cost.input === 0 && cost.output === 0 && cost.cache?.read === 0 && cost.cache?.write === 0
}

export function isFreeModel(model: FreeModel) {
  if (model.providerID !== "mongolgpt" || model.id === "free-auto" || model.id.endsWith("-byok")) return false
  if (model.status === "alpha" || model.status === "deprecated" || model.api.id !== model.id) return false
  if (!zeroCost(model.cost)) return false
  if (model.cost?.experimentalOver200K && !zeroCost(model.cost.experimentalOver200K)) return false
  if (model.cost?.tiers?.some((tier) => !zeroCost(tier))) return false
  try {
    const url = new URL(model.api.url)
    return url.origin === "https://opencode.ai" && /^\/zen(?:\/|$)/.test(url.pathname)
  } catch {
    return false
  }
}
