import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { defineConfig, type Plugin, type PluginOption } from "vite"
import { solidStart } from "@solidjs/start/config"
import { nitro } from "nitro/vite"

const require = createRequire(import.meta.url)

function quoteWindowsDefinePaths(): Plugin {
  function normalizeDefineMap(define: Record<string, unknown> | undefined) {
    if (!define) return
    Object.entries(define).forEach(([key, value]) => {
      if (typeof value !== "string") return
      const quotedPath = value.match(/^(['"])([A-Za-z]:[\\/].*)\1$/)
      if (quotedPath?.[2]) {
        define[key] = JSON.stringify(quotedPath[2].replace(/\\/g, "/"))
        return
      }
      if (/^[A-Za-z]:[\\/]/.test(value)) {
        define[key] = JSON.stringify(value.replace(/\\/g, "/"))
      }
    })
  }

  return {
    name: "mongolgpt-admin:quote-windows-define-paths",
    enforce: "post",
    configResolved(config) {
      normalizeDefineMap(config.define)
      Object.values(config.environments ?? {}).forEach((environment) => {
        normalizeDefineMap(environment.define)
      })
    },
  }
}

function resolveMangledSolidStartRuntimeImports(): Plugin {
  const solidStartConfigPath = require.resolve("@solidjs/start/config")
  const solidStartServerDir = join(dirname(solidStartConfigPath), "..", "server")
  const serverRuntime = join(solidStartServerDir, "server-runtime.js").replace(/\\/g, "/")
  const serverFnsRuntime = join(solidStartServerDir, "server-fns-runtime.js").replace(/\\/g, "/")

  return {
    name: "mongolgpt-admin:resolve-mangled-solid-start-runtime-imports",
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
    port: 3003,
  },
  build: {
    rollupOptions: {
      external: ["cloudflare:workers"],
    },
    minify: true,
  },
})
