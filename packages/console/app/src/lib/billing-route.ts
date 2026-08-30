import { PlanNames, type PlanName } from "@mongolgpt/account-contract"

export type PricingPlan = "free" | PlanName

export function selectedPaidPlan(value: unknown): PlanName | undefined {
  if (typeof value !== "string") return undefined
  return PlanNames.find((plan) => plan === value)
}

export function pricingAuthRoute(plan: PricingPlan) {
  return plan === "free" ? "/auth" : `/auth?plan=${plan}`
}

export function authorizationRoute(plan: unknown) {
  const selected = selectedPaidPlan(plan)
  if (!selected) return "/auth/authorize"
  return `/auth/authorize?continue=${encodeURIComponent(`/auth?plan=${selected}`)}`
}

export function workspacePlanRoute(workspaceID: string | undefined, plan: unknown) {
  const selected = selectedPaidPlan(plan)
  if (!workspaceID) return selected ? `/workspace-picker?plan=${selected}` : "/workspace-picker"
  return selected ? `/workspace/${workspaceID}/billing?plan=${selected}` : `/workspace/${workspaceID}`
}
