type ModelCost = {
  readonly input: number
  readonly output: number
}

export function isManagedFreeModel(input: {
  readonly id: string
  readonly cost?: ModelCost | readonly ModelCost[]
}) {
  if (input.id === "free-auto") return true
  if (!input.cost) return false
  const costs = Array.isArray(input.cost) ? input.cost : [input.cost]
  return costs.length > 0 && costs.every((cost) => cost.input === 0 && cost.output === 0)
}
