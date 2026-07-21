import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { defineConfig, type Plugin, type PluginOption } from "vite"
import { solidStart } from "@solidjs/start/config"
import { nitro } from "nitro/vite"
import { normalizeSolidStartRoutePaths } from "./vite-route-manifest"

const require = createRequire(import.meta.url)

function quoteWindowsDefinePaths(): Plugin {
  function normalizeDefineMap(define: Record<string, any> | undefined) {
    if (!define) return
    for (const [key, value] of Object.entries(define)) {
      if (typeof value !== "string") continue
      const quotedPath = value.match(/^(['"])([A-Za-z]:[\\/].*)\1$/)
      if (quotedPath) {
        define[key] = JSON.stringify(quotedPath[2].replace(/\\/g, "/"))
        continue
      }
      if (/^[A-Za-z]:[\\/]/.test(value)) {
        define[key] = JSON.stringify(value.replace(/\\/g, "/"))
      }
    }
  }

  return {
    name: "mongolgpt:quote-windows-define-paths",
    enforce: "post",
    configResolved(config) {
      normalizeDefineMap(config.define)
      for (const environment of Object.values(config.environments ?? {})) {
        normalizeDefineMap(environment.define)
      }
    },
  }
}

function resolveMangledSolidStartRuntimeImports(): Plugin {
  const solidStartConfigPath = require.resolve("@solidjs/start/config")
  const solidStartServerDir = join(dirname(solidStartConfigPath), "..", "server")
  const serverRuntime = join(solidStartServerDir, "server-runtime.js").replace(/\\/g, "/")
  const serverFnsRuntime = join(solidStartServerDir, "server-fns-runtime.js").replace(/\\/g, "/")

  return {
    name: "mongolgpt:resolve-mangled-solid-start-runtime-imports",
    enforce: "pre",
    resolveId(source) {
      const compact = source.replace(/[^a-z0-9]/gi, "").toLowerCase()
      if (compact.includes("solidjsstartdistserverserverfnsruntime")) return serverFnsRuntime
      if (compact.includes("solidjsstartdistserverserverruntime")) return serverRuntime
      return undefined
    },
  }
}

export default defineConfig({
  plugins: [
    resolveMangledSolidStartRuntimeImports(),
    solidStart({
      middleware: "./src/middleware.ts",
    }) as PluginOption,
    normalizeSolidStartRoutePaths(),
    quoteWindowsDefinePaths(),
    nitro({
      compatibilityDate: "2024-09-19",
      preset: "cloudflare-module",
      cloudflare: {
        nodeCompat: true,
      },
    }),
  ],
  server: {
    allowedHosts: true,
    port: 3001,
  },
  build: {
    rollupOptions: {
      external: ["cloudflare:workers"],
    },
    minify: false,
  },
})
