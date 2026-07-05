import { readFileSync } from "node:fs"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { fileURLToPath } from "url"

const theme = fileURLToPath(new URL("./public/mongolgpt-theme-preload.js", import.meta.url))

const channel = (() => {
  const raw = process.env.MONGOLGPT_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  if (raw === "latest") return "prod"
  return "dev"
})()

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
          "import.meta.env.VITE_MONGOLGPT_CHANNEL": JSON.stringify(channel),
        },
        worker: {
          format: "es",
        },
      }
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
