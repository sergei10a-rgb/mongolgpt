import { describe, expect, test } from "bun:test"
import { OauthCallbackPage } from "../src/oauth/page"

describe("OauthCallbackPage", () => {
  test("renders the MongolGPT brand without the legacy OpenCode wordmark", () => {
    const html = OauthCallbackPage.success({ provider: "MongolGPT", autoClose: false })

    expect(html).toContain(`aria-label="MongolGPT"`)
    expect(html).toContain(">MongolGPT</text>")
    expect(html.toLowerCase()).not.toContain("opencode")
    expect(html).toContain("MongolGPT бүртгэл амжилттай холбогдлоо.")
    expect(html).not.toContain("MongolGPT MongolGPT")
  })

  test("escapes bootstrap options embedded in the inline script", () => {
    const html = OauthCallbackPage.bootstrap({
      provider: `xAI</script><script>alert("provider")</script>`,
      tokenPath: `/token</script><script>alert("path")</script>`,
    })

    expect(html.match(/<\/script>/g)).toHaveLength(1)
    expect(html).toContain(`xAI\\u003c/script>\\u003cscript>alert(\\\"provider\\\")\\u003c/script>`)
    expect(html).toContain(`/token\\u003c/script>\\u003cscript>alert(\\\"path\\\")\\u003c/script>`)
  })

  test("keeps the MongolGPT account message deduplicated after bootstrap", () => {
    const html = OauthCallbackPage.bootstrap({ provider: "MongolGPT", tokenPath: "/token" })

    expect(html).toContain(`PRODUCT_PROVIDER=PROVIDER.trim().toLowerCase()==="mongolgpt"`)
    expect(html).toContain("MongolGPT бүртгэл амжилттай холбогдлоо.")
    expect(html).toContain('document.title="Зөвшөөрөл амжилттай - MongolGPT"')
    expect(html).not.toContain('message.textContent=PROVIDER?("MongolGPT "+PROVIDER')
  })
})
