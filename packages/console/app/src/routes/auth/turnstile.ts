import { TURNSTILE_ACTION } from "@mongolgpt/console-core/turnstile.js"

export function renderTurnstileChallenge(input: {
  siteKey: string
  authorizationUrl: string
  error?: "invalid" | "unavailable" | "misconfigured"
}) {
  const siteKey = input.siteKey.trim()
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(siteKey)) throw new Error("Turnstile site key тохиргоо буруу байна.")
  const authorization = authorizationForm(input.authorizationUrl)
  const error = input.error
    ? `<p class="notice" role="alert">${
        input.error === "unavailable"
          ? "Хамгаалалтын үйлчилгээ түр хариу өгөхгүй байна. Хэсэг хүлээгээд дахин оролдоно уу."
          : input.error === "misconfigured"
            ? "Нэвтрэх хамгаалалтын тохиргоо дутуу байна. MongolGPT-ийн админтай холбогдоно уу."
            : "Хүний баталгаажуулалт амжилтгүй боллоо. Дахин оролдоно уу."
      }</p>`
    : ""

  return {
    authOrigin: authorization.origin,
    html: `<!doctype html>
<html lang="mn">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <title>MongolGPT-д нэвтрэх</title>
    <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
    <style>
      :root { color-scheme: light dark; font-family: Inter, "Segoe UI", Arial, sans-serif; background: #f7f7f5; color: #181918; }
      * { box-sizing: border-box; }
      body { min-height: 100dvh; margin: 0; display: grid; place-items: center; padding: 28px 20px; background: #f7f7f5; }
      main { width: min(100%, 420px); display: grid; gap: 18px; }
      .mark { width: 42px; height: 42px; display: grid; place-items: center; border-radius: 7px; background: #181918; color: #fff; font-size: 20px; font-weight: 700; }
      .eyebrow { margin: 6px 0 0; color: #626660; font-size: 13px; font-weight: 600; }
      h1 { margin: 0; font-size: 30px; line-height: 1.2; letter-spacing: 0; }
      p { margin: 0; color: #4b4f4a; font-size: 15px; line-height: 1.6; }
      form { display: grid; gap: 16px; }
      .cf-turnstile { min-height: 65px; }
      button { min-height: 42px; width: 100%; border: 0; border-radius: 6px; background: #16764a; color: #fff; font: inherit; font-weight: 650; cursor: pointer; }
      button:hover { background: #105f3b; }
      button:focus-visible { outline: 3px solid #7bcaa5; outline-offset: 2px; }
      .notice { padding: 12px 14px; border-left: 3px solid #b43b32; background: #fff0ee; color: #74261f; }
      .privacy { font-size: 12px; color: #737872; }
      @media (prefers-color-scheme: dark) {
        :root, body { background: #121412; color: #f2f4f1; }
        .mark { background: #f2f4f1; color: #121412; }
        .eyebrow, p, .privacy { color: #aeb4ad; }
        .notice { background: #351b19; color: #ffb7b0; }
      }
    </style>
  </head>
  <body>
    <main aria-labelledby="login-title">
      <span class="mark" aria-hidden="true">M</span>
      <p class="eyebrow">Нэвтрэх хамгаалалт</p>
      <h1 id="login-title">MongolGPT-д үргэлжлүүлэх</h1>
      <p>Нэвтрэхийн өмнө аюулгүй байдлын богино шалгалтыг гүйцээнэ үү.</p>
      ${error}
      <form action="${escapeHtml(authorization.action)}" method="post">
        ${authorization.fields}
        <div class="cf-turnstile" data-sitekey="${escapeHtml(siteKey)}" data-action="${TURNSTILE_ACTION}" data-language="mn" data-theme="auto" data-size="flexible"></div>
        <button type="submit">Үргэлжлүүлэх</button>
      </form>
      <p class="privacy">Шалгалтын токеныг зөвхөн энэ нэвтрэлтийг хамгаалахад ашиглана.</p>
    </main>
  </body>
</html>`,
  }
}

function authorizationForm(value: string) {
  const url = new URL(value)
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1"
  const authorizePath = url.pathname === "/authorize" || (loopback && url.pathname === "/auth/authorize")
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    !authorizePath ||
    url.hash
  ) {
    throw new Error("OAuth authorize URL тохиргоо буруу байна.")
  }
  const fields = [
    "client_id",
    "redirect_uri",
    "response_type",
    "state",
    "code_challenge",
    "code_challenge_method",
  ].flatMap((name) => {
    const values = url.searchParams.getAll(name)
    if (values.length === 0 && (name === "code_challenge" || name === "code_challenge_method")) return []
    const value = values[0]
    if (values.length !== 1 || !value || value.length > 2_048) {
      throw new Error("OAuth authorize хүсэлт дутуу байна.")
    }
    return [`<input type="hidden" name="${name}" value="${escapeHtml(value)}">`]
  })
  return {
    origin: url.origin,
    action: `${url.origin}${url.pathname}`,
    fields: fields.join("\n        "),
  }
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    if (character === "&") return "&amp;"
    if (character === "<") return "&lt;"
    if (character === ">") return "&gt;"
    if (character === '"') return "&quot;"
    return "&#39;"
  })
}
