export type ProviderCircuitOutcome = "success" | "transient-error" | "permanent-error"

export type ProviderCircuitPermit = {
  key: string
  generation: number
  probe: boolean
}

export type ProviderCircuitOptions = {
  failureThreshold?: number
  cooldownMs?: number
  now?: () => number
}

export type ProviderCircuitScope = {
  workspaceID: string
  modelID: string
}

type ProviderCircuitState = {
  consecutiveFailures: number
  openedAt?: number
  generation: number
  probeInFlight: boolean
}

const DEFAULT_FAILURE_THRESHOLD = 3
const DEFAULT_COOLDOWN_MS = 30_000

export function createProviderCircuit(options: ProviderCircuitOptions = {}) {
  const failureThreshold = Math.max(1, Math.floor(options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD))
  const cooldownMs = Math.max(0, options.cooldownMs ?? DEFAULT_COOLDOWN_MS)
  const now = options.now ?? Date.now
  const states = new Map<string, ProviderCircuitState>()

  function acquire(key: string): ProviderCircuitPermit | undefined {
    const timestamp = now()
    const state = states.get(key)
    if (!state) return { key, generation: 0, probe: false }

    if (state.openedAt === undefined) return { key, generation: state.generation, probe: false }
    if (timestamp - state.openedAt < cooldownMs || state.probeInFlight) return undefined

    state.probeInFlight = true
    return { key, generation: state.generation, probe: true }
  }

  function record(permit: ProviderCircuitPermit, outcome: ProviderCircuitOutcome) {
    const timestamp = now()
    const state = states.get(permit.key)

    if (outcome === "permanent-error") {
      // A client/configuration error must not trip the circuit. Release a probe
      // without treating it as provider health evidence.
      if (state?.generation === permit.generation && permit.probe) {
        state.probeInFlight = false
        state.openedAt = timestamp
      }
      return
    }

    if (outcome === "success") {
      if (!state || state.generation === permit.generation) states.delete(permit.key)
      return
    }

    if (state && state.generation !== permit.generation) return

    if (permit.probe) {
      if (!state) return
      state.probeInFlight = false
      state.openedAt = timestamp
      return
    }

    const next: ProviderCircuitState = state ?? {
      consecutiveFailures: 0,
      generation: permit.generation,
      probeInFlight: false,
    }
    next.consecutiveFailures += 1
    if (next.consecutiveFailures >= failureThreshold) {
      next.openedAt = timestamp
      next.generation += 1
      next.probeInFlight = false
    }
    states.set(permit.key, next)
  }

  return {
    acquire,
    record,
    snapshot(key: string) {
      const state = states.get(key)
      return state ? { ...state } : undefined
    },
    reset() {
      states.clear()
    },
  }
}

export function providerCircuitKey(providerID: string, scope?: ProviderCircuitScope) {
  return JSON.stringify(scope ? ["byok", scope.workspaceID, scope.modelID, providerID] : ["managed", providerID])
}

export const providerCircuit = createProviderCircuit()
