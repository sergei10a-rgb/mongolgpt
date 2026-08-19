#!/usr/bin/env bun

import { Script } from "@mongolgpt/script"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const generated = await import("./generate.ts")
const nodePtyPackage = `@lydell/node-pty-${process.platform}-${process.arch}`
const jsoncParserEsm = fileURLToPath(import.meta.resolve("jsonc-parser/lib/esm/main.js"))

await Bun.build({
  target: "node",
  entrypoints: ["./src/node.ts"],
  outdir: "./dist/node",
  format: "esm",
  sourcemap: "linked",
  external: [nodePtyPackage],
  plugins: [
    {
      name: "mongolgpt:desktop-server-dependency-resolver",
      setup(build) {
        build.onResolve({ filter: /^jsonc-parser$/ }, () => ({ path: jsoncParserEsm }))
        build.onResolve({ filter: /^@lydell\/node-pty$/ }, () => ({ path: "node-pty-proxy", namespace: "mongolgpt" }))
        build.onLoad({ filter: /^node-pty-proxy$/, namespace: "mongolgpt" }, () => ({
          contents: `import nodePty from ${JSON.stringify(nodePtyPackage)}; export const spawn = nodePty.spawn;`,
          loader: "js",
        }))
      },
    },
  ],
  define: {
    MONGOLGPT_MODELS_DEV: generated.modelsData,
    MONGOLGPT_CHANNEL: `'${Script.channel}'`,
  },
  files: {
    "mongolgpt-web-ui.gen.ts": "",
  },
})

console.log("Build complete")
