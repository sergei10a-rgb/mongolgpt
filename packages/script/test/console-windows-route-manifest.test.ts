import { describe, expect, test } from "bun:test"
import { isSolidStartRoutesModule, normalizeSolidStartRouteManifest } from "../../console/app/vite-route-manifest"

describe("console Windows route manifest", () => {
  test("normalizes only SolidStart route path properties", () => {
    const source = String.raw`import("C:\\repo\\src\\routes\\pricing\\index.tsx");export default [{"path":"/pricing\\"},{"path":"/bench\\:id"},{"src":"C:\\repo\\route.tsx"}]`
    const normalized = normalizeSolidStartRouteManifest(source)

    expect(normalized).toContain('{"path":"/pricing/"}')
    expect(normalized).toContain('{"path":"/bench/:id"}')
    expect(normalized).toContain(String.raw`{"src":"C:\\repo\\route.tsx"}`)
    expect(normalized).toContain(String.raw`import("C:\\repo\\src\\routes\\pricing\\index.tsx")`)
  })

  test("leaves POSIX route manifests unchanged", () => {
    const source = 'export default [{"path":"/pricing/"},{"path":"/bench/:id"}]'
    expect(normalizeSolidStartRouteManifest(source)).toBe(source)
  })

  test("targets the SolidStart routes virtual module only", () => {
    expect(isSolidStartRoutesModule("solid-start:routes")).toBe(true)
    expect(isSolidStartRoutesModule("\0solid-start:routes?client")).toBe(true)
    expect(isSolidStartRoutesModule("other:routes")).toBe(false)
  })
})
