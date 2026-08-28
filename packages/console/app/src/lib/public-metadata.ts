import { canonicalHttpsOrigin } from "~/routes/auth/helpers"

export function publicMetadataBaseUrl(requestUrl: string | undefined, publicUrl: string | undefined, rootUrl: string | undefined) {
  const requestOrigin = requestUrlOrigin(requestUrl)
  const rootOrigin = canonicalHttpsOrigin(rootUrl)
  if (requestOrigin && rootOrigin && requestOrigin === rootOrigin) return rootOrigin
  return canonicalHttpsOrigin(publicUrl) ?? publicUrl?.trim() ?? ""
}

function requestUrlOrigin(value: string | undefined) {
  try {
    const url = new URL(value ?? "")
    if (url.protocol !== "https:" || url.username || url.password) return undefined
    return url.origin
  } catch {
    return undefined
  }
}
