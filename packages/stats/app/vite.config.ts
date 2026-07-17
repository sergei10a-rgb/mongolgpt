import { solidStart } from "@solidjs/start/config"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { nitro } from "nitro/vite"
import { defineConfig, type Plugin, type PluginOption } from "vite"

const require = createRequire(import.meta.url)

function resolveMangledSolidStartRuntimeImports(): Plugin {
  const configPath = require.resolve("@solidjs/start/config")
  const serverDirectory = join(dirname(configPath), "..", "server")
  const serverRuntime = join(serverDirectory, "server-runtime.js").replace(/\\/g, "/")
  const serverFunctionsRuntime = join(serverDirectory, "server-fns-runtime.js").replace(/\\/g, "/")

  return {
    name: "mongolgpt:resolve-mangled-solid-start-runtime-imports",
    enforce: "pre",
    resolveId(source) {
      const compact = source.replace(/[^a-z0-9]/gi, "").toLowerCase()
      if (compact.includes("solidjsstartdistserverserverfnsruntime")) return serverFunctionsRuntime
      if (compact.includes("solidjsstartdistserverserverruntime")) return serverRuntime
    },
  }
}

function quoteWindowsDefinePaths(): Plugin {
  function normalize(define: Record<string, unknown> | undefined) {
    if (!define) return
    for (const [key, value] of Object.entries(define)) {
      if (typeof value !== "string") continue
      const quoted = value.match(/^(['"])([A-Za-z]:[\\/].*)\1$/)
      const path = quoted?.[2] ?? (/^[A-Za-z]:[\\/]/.test(value) ? value : undefined)
      if (path) define[key] = JSON.stringify(path.replace(/\\/g, "/"))
    }
  }

  return {
    name: "mongolgpt:quote-windows-define-paths",
    enforce: "post",
    configResolved(config) {
      normalize(config.define)
      for (const environment of Object.values(config.environments ?? {})) normalize(environment.define)
    },
  }
}

export default defineConfig({
  base: "/data/",
  plugins: [
    resolveMangledSolidStartRuntimeImports(),
    solidStart() as PluginOption,
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
  },
  build: {
    rollupOptions: {
      external: ["cloudflare:workers"],
    },
    minify: false,
  },
})
