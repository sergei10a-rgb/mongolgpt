import { readFileSync } from "node:fs"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { fileURLToPath } from "url"
import { resolveChannel, resolveReleaseSha, resolveRuntimeMetadata } from "./src/utils/build-config.js"

const theme = fileURLToPath(new URL("./public/mongolgpt-theme-preload.js", import.meta.url))
const channel = resolveChannel()
const runtime = resolveRuntimeMetadata()
const releaseSha = resolveReleaseSha()

/**
 * @type {import("vite").PluginOption}
 */
export default [
  {
    name: "mongolgpt-desktop:config",
    config() {
      return {
        resolve: {
          alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
          },
        },
        define: {
          "import.meta.env.VITE_MONGOLGPT_CHANNEL": JSON.stringify(channel),
          "import.meta.env.VITE_MONGOLGPT_RUNTIME_MODE": JSON.stringify(runtime.mode),
          "import.meta.env.VITE_MONGOLGPT_SERVER_URL": JSON.stringify(runtime.serverUrl),
          "import.meta.env.VITE_MONGOLGPT_RELEASE_SHA": JSON.stringify(releaseSha),
        },
        worker: {
          format: "es",
        },
      }
    },
    transformIndexHtml(html) {
      const metadata = [
        `<meta name="mongolgpt-channel" content="${channel}">`,
        `<meta name="mongolgpt-runtime-mode" content="${runtime.mode}">`,
        `<meta name="mongolgpt-server-url" content="${runtime.serverUrl}">`,
        `<meta name="mongolgpt-release-sha" content="${releaseSha}">`,
      ].join("\n    ")
      return html.replace("</head>", `    ${metadata}\n  </head>`)
    },
  },
  {
    name: "mongolgpt-desktop:theme-preload",
    transformIndexHtml(html) {
      return html.replace(
        '<script id="mongolgpt-theme-preload-script" src="/mongolgpt-theme-preload.js"></script>',
        `<script id="mongolgpt-theme-preload-script">${readFileSync(theme, "utf8")}</script>`,
      )
    },
  },
  tailwindcss(),
  solidPlugin(),
]
