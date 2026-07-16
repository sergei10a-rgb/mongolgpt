import { expect, test } from "bun:test"
import { popularProviders } from "./use-providers"

test("keeps NVIDIA visible as an optional popular provider", () => {
  expect(popularProviders).toContain("nvidia")
})
