import {
  documentationRepositoryUrl,
  repositoryUrl,
  repositorySupportUrl,
} from "@mongolgpt/core/product"

function value(input: string | undefined, fallback: string) {
  const next = input?.trim()
  return next || fallback
}

export const productUrl = value(import.meta.env.VITE_MONGOLGPT_PUBLIC_URL, repositoryUrl)
export const docsUrl = value(import.meta.env.VITE_MONGOLGPT_DOCS_URL, documentationRepositoryUrl)
export const supportUrl = value(import.meta.env.VITE_MONGOLGPT_SUPPORT_URL, repositorySupportUrl)
export const changelogUrl = import.meta.env.VITE_MONGOLGPT_CHANGELOG_URL?.trim() || undefined

export function documentationUrl(path = "") {
  const suffix = path.replace(/^\/+/, "")
  if (!suffix) return docsUrl
  return `${docsUrl.replace(/\/+$/, "")}/${suffix}`
}
