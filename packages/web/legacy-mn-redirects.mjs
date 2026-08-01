export const legacyMongolianDocSlugs = [
  "acp",
  "agents",
  "cli",
  "commands",
  "config",
  "custom-tools",
  "ecosystem",
  "enterprise",
  "formatters",
  "github",
  "gitlab",
  "ide",
  "keybinds",
  "lsp",
  "mcp-servers",
  "models",
  "network",
  "permissions",
  "plugins",
  "policies",
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

/** @param {string} html */
export function normalizeStaticRedirectHtmlDocument(html) {
  if (!html.includes('<meta http-equiv="refresh"') || /<html[\s>]/i.test(html)) return html

  return html
    .replace(/^<!doctype html>/i, '<!doctype html><html lang="mn"><head>')
    .replace(/<body>/i, "</head><body>")
    .replace(/<\/body>\s*$/i, "</body></html>")
}
