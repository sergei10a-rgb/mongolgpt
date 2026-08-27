import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

export const legacyMongolianDocSlugs = [
  "account",
  "acp",
  "admin",
  "agents",
  "backup-restore",
  "billing",
  "cli",
  "commands",
  "config",
  "custom-tools",
  "deployment",
  "desktop",
  "ecosystem",
  "enterprise",
  "faq",
  "formatters",
  "github",
  "gitlab",
  "ide",
  "install",
  "keybinds",
  "lsp",
  "mcp-servers",
  "models",
  "network",
  "permissions",
  "plugins",
  "policies",
  "privacy",
  "providers",
  "references",
  "rules",
  "sdk",
  "server",
  "share",
  "skills",
  "themes",
  "tools",
  "troubleshooting",
  "tui",
  "web",
  "windows-wsl",
]

/** @type {Record<string, string>} */
export const legacyMongolianDocRedirects = {
  "/mn": "/docs/",
  ...Object.fromEntries(legacyMongolianDocSlugs.map((slug) => [`/mn/${slug}`, `/docs/${slug}`])),
}

export const staticDocsEntrypointRedirects = {
  "/": "/docs/",
  ...legacyMongolianDocRedirects,
}

/** @param {string} target */
export function staticRedirectHtmlDocument(target) {
  if (!target.startsWith("/") || target.startsWith("//")) {
    throw new Error("Static docs redirect нь зөвхөн тухайн домэйны absolute path руу заана")
  }

  const escaped = target
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")

  return [
    '<!doctype html><html lang="mn"><head><meta charset="utf-8">',
    '<meta name="robots" content="noindex">',
    `<meta http-equiv="refresh" content="0;url=${escaped}">`,
    `<link rel="canonical" href="${escaped}">`,
    '<link rel="icon" href="/docs/favicon-v3.svg">',
    "<title>MongolGPT баримт бичиг</title></head>",
    `<body><a href="${escaped}">MongolGPT баримт бичиг рүү шилжих</a></body></html>`,
  ].join("")
}

/** @param {string} root */
export function writeStaticDocsEntrypointRedirects(root) {
  for (const [source, target] of Object.entries(staticDocsEntrypointRedirects)) {
    const segments = source === "/" ? [] : source.slice(1).split("/")
    const destination = join(root, ...segments, "index.html")
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, staticRedirectHtmlDocument(target))
  }
}

/** @param {string} html */
export function normalizeStaticRedirectHtmlDocument(html) {
  if (!html.includes('<meta http-equiv="refresh"') || /<html[\s>]/i.test(html)) return html

  return html
    .replace(/^<!doctype html>/i, '<!doctype html><html lang="mn"><head>')
    .replace(/<body>/i, "</head><body>")
    .replace(/<\/body>\s*$/i, "</body></html>")
}
