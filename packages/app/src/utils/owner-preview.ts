export const ownerPreviewOrigin = "https://preview.dev.mgpt.mn"

export function isOwnerPreviewRuntime(appOrigin: string, serverUrl: string) {
  return appOrigin === ownerPreviewOrigin && serverUrl === ownerPreviewOrigin
}
