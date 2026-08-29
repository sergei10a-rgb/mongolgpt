export function authStateError(consoleOrigin?: string) {
  const home = safeConsoleHome(consoleOrigin)
  const homeLink = home ? `<a href="${home}">MongolGPT нүүр хуудас руу буцах</a>` : ""

  return new Response(
    `<!doctype html>
<html lang="mn">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <title>MongolGPT нэвтрэлт тасалдлаа</title>
    <style>
      :root { color-scheme: light dark; font-family: Inter, "Segoe UI", Arial, sans-serif; background: #f7f7f5; color: #181918; }
      * { box-sizing: border-box; }
      body { min-height: 100dvh; margin: 0; display: grid; place-items: center; padding: 28px 20px; background: #f7f7f5; }
      main { width: min(100%, 440px); display: grid; gap: 18px; }
      .mark { width: 42px; height: 42px; display: grid; place-items: center; border-radius: 7px; background: #181918; color: #fff; font-size: 20px; font-weight: 700; }
      .eyebrow { margin: 6px 0 0; color: #626660; font-size: 13px; font-weight: 600; }
      h1 { margin: 0; font-size: 30px; line-height: 1.2; letter-spacing: 0; }
      p { margin: 0; color: #4b4f4a; font-size: 15px; line-height: 1.6; }
      a { width: fit-content; color: #116640; font-weight: 650; text-underline-offset: 3px; }
      a:focus-visible { outline: 3px solid #7bcaa5; outline-offset: 3px; }
      @media (prefers-color-scheme: dark) {
        :root, body { background: #121412; color: #f2f4f1; }
        .mark { background: #f2f4f1; color: #121412; }
        .eyebrow, p { color: #aeb4ad; }
        a { color: #73d2a5; }
      }
    </style>
  </head>
  <body>
    <main aria-labelledby="login-error-title">
      <span class="mark" aria-hidden="true">M</span>
      <p class="eyebrow">Нэвтрэх хамгаалалт</p>
      <h1 id="login-error-title">Нэвтрэх хүсэлт хүчингүй боллоо</h1>
      <p>Нэвтрэх хугацаа дууссан эсвэл урсгалын дундуур өөр хөтөч, өөр таб руу шилжсэн байна.</p>
      <p>Энэ табыг хаагаад нэвтрэлтийг эхлүүлсэн MongolGPT програм эсвэл терминалаасаа дахин эхлүүлнэ үү.</p>
      ${homeLink}
    </main>
  </body>
</html>`,
    {
      status: 400,
      headers: {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
      },
    },
  )
}

function safeConsoleHome(value?: string) {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== "https:" || url.username || url.password) return undefined
    return `${url.origin}/`
  } catch {
    return undefined
  }
}
