// @ts-check
import { defineConfig, passthroughImageService } from "astro/config"
import starlight from "@astrojs/starlight"
import solidJs from "@astrojs/solid-js"
import cloudflare from "@astrojs/cloudflare"
import theme from "toolbeam-docs-theme"
import config from "./config.mjs"
import { rehypeHeadingIds } from "@astrojs/markdown-remark"
import rehypeAutolinkHeadings from "rehype-autolink-headings"
import { spawnSync } from "child_process"
import { readdirSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"
import {
  legacyMongolianDocRedirects,
  normalizeStaticRedirectHtmlDocument,
  writeStaticDocsEntrypointRedirects,
} from "./legacy-mn-redirects.mjs"

const staticDocs = process.env.MONGOLGPT_STATIC_DOCS === "true"

export default defineConfig({
  site: config.url,
  base: config.base,
  redirects: {
    ...legacyMongolianDocRedirects,
  },
  outDir: staticDocs ? "./dist/docs" : "./dist",
  output: staticDocs ? "static" : "server",
  image: {
    service: passthroughImageService(),
  },
  adapter: staticDocs
    ? undefined
    : cloudflare({
        imageService: "passthrough",
      }),
  devToolbar: {
    enabled: false,
  },
  server: {
    host: "0.0.0.0",
  },
  markdown: {
    rehypePlugins: [rehypeHeadingIds, [rehypeAutolinkHeadings, { behavior: "wrap" }]],
  },
  integrations: [
    configSchema(),
    solidJs(),
    starlight({
      title: "MongolGPT",
      defaultLocale: "root",
      locales: {
        root: {
          label: "Монгол",
          lang: "mn",
          dir: "ltr",
        },
      },
      prerender: true,
      pagefind: true,
      favicon: "/favicon-v3.svg",
      head: [
        {
          tag: "link",
          attrs: {
            rel: "icon",
            href: `${config.base}/favicon-v3.ico`,
            sizes: "32x32",
          },
        },
        {
          tag: "link",
          attrs: {
            rel: "icon",
            type: "image/png",
            href: `${config.base}/favicon-96x96-v3.png`,
            sizes: "96x96",
          },
        },
        {
          tag: "link",
          attrs: {
            rel: "apple-touch-icon",
            href: `${config.base}/apple-touch-icon-v3.png`,
            sizes: "180x180",
          },
        },
      ],
      lastUpdated: true,
      expressiveCode: { themes: ["github-light", "github-dark"] },
      social: [{ icon: "github", label: "GitHub", href: config.github }],
      editLink: {
        baseUrl: `${config.github}/edit/main/packages/web/`,
      },
      markdown: {
        headingLinks: false,
      },
      customCss: ["./src/styles/custom.css"],
      logo: {
        light: "./src/assets/logo-light.svg",
        dark: "./src/assets/logo-dark.svg",
        replacesTitle: true,
      },
      sidebar: [
        "",
        { label: "Суулгах", link: "install" },
        "config",
        "providers",
        "network",
        "deployment",
        "release-upgrade",
        "backup-restore",
        "enterprise",
        "troubleshooting",
        { label: "Windows ба WSL", link: "windows-wsl" },
        {
          label: "MongolGPT үйлчилгээ",
          items: ["faq", "privacy", "security", "billing", "admin"],
        },
        {
          label: "Хэрэглээ",
          items: ["account", "desktop", "tui", "cli", "web", "ide", "share", "github", "gitlab"],
        },
        {
          label: "Тохируулах",
          items: [
            "tools",
            "rules",
            "agents",
            "models",
            "themes",
            "keybinds",
            "commands",
            "formatters",
            "permissions",
            "policies",
            "lsp",
            "mcp-servers",
            "acp",
            "skills",
            "references",
            "custom-tools",
          ],
        },
        {
          label: "Хөгжүүлэлт",
          items: ["sdk", "server", "plugins", "ecosystem"],
        },
      ],
      components: {
        Hero: "./src/components/Hero.astro",
        Head: "./src/components/Head.astro",
        Header: "./src/components/Header.astro",
        Footer: "./src/components/Footer.astro",
        SiteTitle: "./src/components/SiteTitle.astro",
        MobileMenuToggle: "./src/components/MobileMenuToggle.astro",
      },
      plugins: [
        theme({
          headerLinks: config.headerLinks,
        }),
      ],
    }),
  ],
})

function configSchema() {
  return {
    name: "configSchema",
    hooks: {
      "astro:build:done": async () => {
        console.log("MongolGPT тохиргооны schema үүсгэж байна")
        spawnSync("../mongolgpt/script/schema.ts", ["./dist/config.json", "./dist/tui.json"])
        if (staticDocs) {
          normalizeStaticRedirectHtml("./dist/docs")
          writeStaticDocsEntrypointRedirects("./dist")
        }
      },
    },
  }
}

/** @param {string} root */
function normalizeStaticRedirectHtml(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      normalizeStaticRedirectHtml(path)
      continue
    }
    if (!entry.name.endsWith(".html")) continue

    const html = readFileSync(path, "utf8")
    const normalized = normalizeStaticRedirectHtmlDocument(html)
    if (normalized !== html) writeFileSync(path, normalized)
  }
}
