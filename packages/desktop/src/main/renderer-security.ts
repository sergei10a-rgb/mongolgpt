export const rendererProtocol = "mongolgpt-renderer"
export const rendererHost = "renderer"

export function isTrustedRendererUrl(value?: string, devUrl = process.env.ELECTRON_RENDERER_URL) {
  if (!value || !URL.canParse(value)) return false
  const url = new URL(value)
  if (url.protocol === `${rendererProtocol}:` && url.host === rendererHost) return true
  if (!devUrl || !URL.canParse(devUrl)) return false
  return url.origin === new URL(devUrl).origin
}

export function assertTrustedRendererSource(value: string | undefined, mainFrame: boolean) {
  if (mainFrame && isTrustedRendererUrl(value)) return
  throw new Error("Итгэлгүй renderer-ийн хүсэлтийг хориглолоо")
}

export function isSafeExternalNavigation(value: string) {
  if (!URL.canParse(value)) return false
  const protocol = new URL(value).protocol
  return protocol === "https:" || protocol === "http:"
}
