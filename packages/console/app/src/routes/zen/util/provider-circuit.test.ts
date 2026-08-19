import { describe, expect, test } from "bun:test"
import { createProviderCircuit, providerCircuitKey } from "./provider-circuit"

describe("provider circuit", () => {
  test("keeps closed routing unchanged and opens after the threshold", () => {
    let time = 0
    const circuit = createProviderCircuit({ failureThreshold: 2, cooldownMs: 100, now: () => time })

    const first = circuit.acquire("openrouter")!
    circuit.record(first, "transient-error")
    expect(circuit.acquire("openrouter")).toBeDefined()

    const second = circuit.acquire("openrouter")!
    circuit.record(second, "transient-error")
    expect(circuit.acquire("openrouter")).toBeUndefined()
    expect(circuit.snapshot("openrouter")).toMatchObject({ consecutiveFailures: 2 })
  })

  test("allows one half-open probe, then closes on success", () => {
    let time = 0
    const circuit = createProviderCircuit({ failureThreshold: 1, cooldownMs: 100, now: () => time })
    circuit.record(circuit.acquire("nvidia")!, "transient-error")

    time = 100
    const probe = circuit.acquire("nvidia")!
    expect(probe.probe).toBe(true)
    expect(circuit.acquire("nvidia")).toBeUndefined()

    circuit.record(probe, "success")
    expect(circuit.acquire("nvidia")).toMatchObject({ probe: false })
  })

  test("reopens after a failed half-open probe", () => {
    let time = 0
    const circuit = createProviderCircuit({ failureThreshold: 1, cooldownMs: 100, now: () => time })
    circuit.record(circuit.acquire("openai")!, "transient-error")

    time = 100
    const probe = circuit.acquire("openai")!
    circuit.record(probe, "transient-error")
    expect(circuit.acquire("openai")).toBeUndefined()

    time = 199
    expect(circuit.acquire("openai")).toBeUndefined()
    time = 200
    expect(circuit.acquire("openai")?.probe).toBe(true)
  })

  test("does not trip on permanent client errors and keeps providers independent", () => {
    let time = 0
    const circuit = createProviderCircuit({ failureThreshold: 1, cooldownMs: 100, now: () => time })
    const clientError = circuit.acquire("openrouter")!
    circuit.record(clientError, "permanent-error")
    expect(circuit.acquire("openrouter")).toMatchObject({ probe: false })

    circuit.record(circuit.acquire("nvidia")!, "transient-error")
    expect(circuit.acquire("nvidia")).toBeUndefined()
    expect(circuit.acquire("openrouter")).toMatchObject({ probe: false })
  })

  test("success resets accumulated transient failures", () => {
    const circuit = createProviderCircuit({ failureThreshold: 3 })
    const first = circuit.acquire("provider")!
    circuit.record(first, "transient-error")
    circuit.record(circuit.acquire("provider")!, "success")
    circuit.record(circuit.acquire("provider")!, "transient-error")
    expect(circuit.snapshot("provider")).toMatchObject({ consecutiveFailures: 1 })
  })

  test("isolates BYOK health by workspace and model from managed providers", () => {
    const circuit = createProviderCircuit({ failureThreshold: 1 })
    const managed = providerCircuitKey("openrouter")
    const firstTenant = providerCircuitKey("openrouter", { workspaceID: "workspace-1", modelID: "model-a" })
    const secondTenant = providerCircuitKey("openrouter", { workspaceID: "workspace-2", modelID: "model-a" })
    const secondModel = providerCircuitKey("openrouter", { workspaceID: "workspace-1", modelID: "model-b" })

    circuit.record(circuit.acquire(firstTenant)!, "transient-error")

    expect(circuit.acquire(firstTenant)).toBeUndefined()
    expect(circuit.acquire(secondTenant)).toBeDefined()
    expect(circuit.acquire(secondModel)).toBeDefined()
    expect(circuit.acquire(managed)).toBeDefined()
  })
})
