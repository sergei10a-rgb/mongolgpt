import type { Plugin } from "vite"

const routePathProperty = /("path"\s*:\s*)("(?:\\.|[^"\\])*")/g

export function normalizeSolidStartRouteManifest(code: string) {
  return code.replace(routePathProperty, (match, prefix: string, encodedPath: string) => {
    try {
      const path = JSON.parse(encodedPath)
      if (typeof path !== "string" || !path.includes("\\")) return match
      return `${prefix}${JSON.stringify(path.replaceAll("\\", "/"))}`
    } catch {
      return match
    }
  })
}

export function isSolidStartRoutesModule(id: string) {
  return id.replaceAll("\0", "").split("?", 1)[0].endsWith("solid-start:routes")
}

export function normalizeSolidStartRoutePaths(): Plugin {
  return {
    name: "mongolgpt:normalize-solid-start-route-paths",
    enforce: "post",
    transform(code, id) {
      if (!isSolidStartRoutesModule(id)) return undefined

      const normalized = normalizeSolidStartRouteManifest(code)
      if (normalized === code) return undefined
      return { code: normalized, map: null }
    },
  }
}
