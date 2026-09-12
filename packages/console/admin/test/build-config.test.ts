import { expect, test } from "bun:test"
import { adminCompatibility } from "../cloudflare.config"
import { normalizeSolidStartRouteManifest } from "../../app/vite-route-manifest"

test("admin builds and deployments share the Web Crypto-compatible configuration", async () => {
  const vite = await Bun.file(new URL("../vite.config.ts", import.meta.url)).text()
  const infra = await Bun.file(new URL("../../../../infra/admin-deployment.ts", import.meta.url)).text()
  expect(adminCompatibility.date >= "2024-09-26").toBe(true)
  expect(adminCompatibility.flags).not.toContain("do_not_set_tostring_tag")
  expect(vite).toContain("compatibilityDate: adminCompatibility.date")
  expect(vite).toContain("compatibility_flags: adminCompatibility.flags")
  expect(infra).toContain("server: { compatibility: adminCompatibility }")
})

test("admin enables the existing route normalizer for Windows page and API routes", async () => {
  const vite = await Bun.file(new URL("../vite.config.ts", import.meta.url)).text()
  expect(vite).toContain("normalizeSolidStartRoutePaths(),")
  const routes = [{ path: "/users\\" }, { path: "/users\\:accountID" }, { path: "/api\\support\\:ticketID" }]
  expect(JSON.parse(normalizeSolidStartRouteManifest(JSON.stringify(routes)))).toEqual([
    { path: "/users/" },
    { path: "/users/:accountID" },
    { path: "/api/support/:ticketID" },
  ])
})
