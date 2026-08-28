import { Link } from "@solidjs/meta"
import { For } from "solid-js"
import { getRequestEvent } from "solid-js/web"
import { config } from "~/config"
import { useLanguage } from "~/context/language"
import { LOCALES, route, tag } from "~/lib/language"
import { publicMetadataBaseUrl } from "~/lib/public-metadata"

function skip(path: string) {
  const evt = getRequestEvent()
  if (!evt) return false

  const key = "__locale_links_seen"
  const locals = evt.locals as Record<string, unknown>
  const seen = stringSet(locals[key]) ?? new Set<string>()
  locals[key] = seen
  if (seen.has(path)) return true
  seen.add(path)
  return false
}

function stringSet(value: unknown) {
  if (!(value instanceof Set)) return undefined
  const result = new Set<string>()
  for (const item of value) if (typeof item === "string") result.add(item)
  return result
}

export function LocaleLinks(props: { path: string }) {
  const language = useLanguage()
  if (skip(props.path)) return null
  const baseUrl = publicMetadataBaseUrl(getRequestEvent()?.request.url, config.baseUrl, import.meta.env.VITE_MONGOLGPT_ROOT_URL)

  return (
    <>
      <Link rel="canonical" href={`${baseUrl}${route(language.locale(), props.path)}`} />
      <For each={LOCALES}>
        {(locale) => (
          <Link rel="alternate" hreflang={tag(locale)} href={`${baseUrl}${route(locale, props.path)}`} />
        )}
      </For>
      <Link rel="alternate" hreflang="x-default" href={`${baseUrl}${props.path}`} />
    </>
  )
}
