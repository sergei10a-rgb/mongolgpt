import { TURNSTILE_ACTION, TURNSTILE_RESPONSE_FIELD } from "@mongolgpt/console-core/turnstile.js"

export function renderTurnstileChallenge(input: {
  siteKey: string
  scriptNonce: string
  authorizationUrl: string
  consoleOrigin: string
  error?: "invalid" | "unavailable" | "misconfigured"
}) {
  const siteKey = input.siteKey.trim()
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(siteKey)) throw new Error("Turnstile site key тохиргоо буруу байна.")
  const scriptNonce = input.scriptNonce.trim()
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(scriptNonce)) throw new Error("Turnstile script nonce тохиргоо буруу байна.")
  const authorization = authorizationForm(input.authorizationUrl, input.consoleOrigin)
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
    callbackOrigin: authorization.callbackOrigin,
    html: `<!doctype html>
<html lang="mn">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <title>MongolGPT-д нэвтрэх</title>
    <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" defer></script>
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
      button:disabled { cursor: wait; opacity: .62; }
      .notice { padding: 12px 14px; border-left: 3px solid #b43b32; background: #fff0ee; color: #74261f; }
      .status { min-height: 24px; font-size: 13px; }
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
        <input type="hidden" id="turnstile-response" name="${TURNSTILE_RESPONSE_FIELD}" value="">
        <div class="cf-turnstile" data-sitekey="${escapeHtml(siteKey)}" data-action="${TURNSTILE_ACTION}" data-language="auto" data-theme="auto" data-size="flexible" data-response-field="false" data-callback="mongolGPTTurnstileReady" data-expired-callback="mongolGPTTurnstileExpired" data-timeout-callback="mongolGPTTurnstileExpired" data-error-callback="mongolGPTTurnstileError"></div>
        <p class="status" id="turnstile-status" role="status">Хамгаалалтын шалгалтыг хүлээж байна...</p>
        <button type="submit" disabled>Үргэлжлүүлэх</button>
      </form>
      <p class="privacy">Шалгалтын токеныг зөвхөн энэ нэвтрэлтийг хамгаалахад ашиглана.</p>
    </main>
    <script nonce="${scriptNonce}">
      (() => {
        const form = document.querySelector("form")
        const button = form.querySelector("button[type=submit]")
        const status = document.getElementById("turnstile-status")
        const response = () => document.getElementById("turnstile-response")
        const update = (ready, message) => {
          button.disabled = !ready
          status.hidden = ready
          status.textContent = message
        }
        const reset = (message) => {
          const field = response()
          if (field) field.value = ""
          update(false, message)
        }
        window.mongolGPTTurnstileReady = (token) => {
          const field = response()
          if (field && typeof token === "string") field.value = token
          update(Boolean(field && field.value), field && field.value ? "" : "Хамгаалалтын токен үүссэнгүй. Хуудсыг дахин ачаална уу.")
        }
        window.mongolGPTTurnstileExpired = () => reset("Шалгалтын хугацаа дууслаа. Дахин баталгаажуулна уу.")
        window.mongolGPTTurnstileError = () => reset("Хамгаалалтын шалгалтыг эхлүүлж чадсангүй. Хуудсыг дахин ачаална уу.")
        form.addEventListener("submit", (event) => {
          const token = response()
          if (!token || !token.value) {
            event.preventDefault()
            update(false, "Эхлээд хамгаалалтын шалгалтыг гүйцээнэ үү.")
            return
          }
          button.disabled = true
          status.hidden = false
          status.textContent = "Нэвтрэх үйлчилгээнд шилжүүлж байна..."
        })
      })()
    </script>
  </body>
</html>`,
  }
}

function authorizationForm(value: string, consoleOriginValue: string) {
  const url = new URL(value)
  const consoleOrigin = new URL(consoleOriginValue)
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
  const clientID = url.searchParams.get("client_id")
  const redirectURI = url.searchParams.get("redirect_uri")
  if (!redirectURI) throw new Error("OAuth authorize хүсэлт дутуу байна.")
  const callback = new URL(redirectURI)
  const callbackLoopback = callback.hostname === "localhost" || callback.hostname === "127.0.0.1"
  const validAppCallback =
    clientID === "app" &&
    callback.protocol === "https:" &&
    callback.origin === consoleOrigin.origin &&
    (callback.pathname === "/auth/callback" || callback.pathname.startsWith("/auth/callback/"))
  const callbackPort = Number(callback.port)
  const validCliCallback =
    clientID === "mongolgpt-cli" &&
    callback.protocol === "http:" &&
    callbackLoopback &&
    callback.pathname === "/auth/callback" &&
    !callback.search &&
    Number.isInteger(callbackPort) &&
    callbackPort >= 1_024 &&
    callbackPort <= 65_535
  if (
    consoleOrigin.protocol !== "https:" ||
    consoleOrigin.pathname !== "/" ||
    consoleOrigin.search ||
    consoleOrigin.hash ||
    callback.username ||
    callback.password ||
    callback.hash ||
    (!validAppCallback && !validCliCallback)
  ) {
    throw new Error("OAuth callback URL тохиргоо буруу байна.")
  }
  return {
    origin: url.origin,
    action: `${url.origin}${url.pathname}`,
    callbackOrigin: callback.origin,
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
