import { defineMiddleware } from "astro:middleware"

export const onRequest = defineMiddleware((ctx, next) => {
  const hit = /^\/docs\/(?:mn|root)(\/.*)?$/.exec(ctx.url.pathname)
  if (!hit) return next()

  const url = new URL(ctx.url)
  url.pathname = `/docs${hit[1] ?? "/"}`
  return new Response(null, {
    status: 308,
    headers: {
      Location: url.toString(),
      "Set-Cookie": "mongolgpt_locale=root; Path=/; Max-Age=31536000; SameSite=Lax",
    },
  })
})
