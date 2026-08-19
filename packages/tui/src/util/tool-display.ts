export function webSearchProviderLabel(provider: unknown) {
  if (provider === "parallel") return "Parallel үйлчилгээгээр вэб хайх"
  if (provider === "exa") return "Exa үйлчилгээгээр вэб хайх"
  return "Вэб хайлт"
}

export function toolDisplayMetadata(state: unknown): Record<string, unknown> {
  if (!state || typeof state !== "object" || Array.isArray(state)) return {}
  if (!("status" in state) || state.status === "pending") return {}
  if (!("structured" in state) || !state.structured || typeof state.structured !== "object") return {}
  if (Array.isArray(state.structured)) return {}
  return state.structured as Record<string, unknown>
}
