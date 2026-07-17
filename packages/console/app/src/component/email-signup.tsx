import { action, useSubmission } from "@solidjs/router"
import {
  InvalidNewsletterSubscriptionError,
  subscribeNewsletter,
} from "@mongolgpt/console-core/newsletter.js"
import { Show } from "solid-js"
import { useI18n } from "~/context/i18n"
import { useLanguage } from "~/context/language"

const emailSignup = action(async (formData: FormData) => {
  "use server"
  try {
    await subscribeNewsletter({
      email: formData.get("email"),
      locale: formData.get("locale"),
      source: "console",
    })
    return true
  } catch (error) {
    if (error instanceof InvalidNewsletterSubscriptionError) throw new Error(error.message)
    console.error("Newsletter subscription failed", error instanceof Error ? error.name : typeof error)
    throw new Error("Бүртгэл түр амжилтгүй боллоо. Дараа дахин оролдоно уу.")
  }
})

export function EmailSignup() {
  const submission = useSubmission(emailSignup)
  const i18n = useI18n()
  const language = useLanguage()
  return (
    <section data-component="email">
      <div data-slot="section-title">
        <h3>{i18n.t("email.title")}</h3>
        <p>{i18n.t("email.subtitle")}</p>
      </div>
      <form data-slot="form" action={emailSignup} method="post">
        <input type="hidden" name="locale" value={language.locale()} />
        <input type="email" name="email" placeholder={i18n.t("email.placeholder")} required />
        <button type="submit" disabled={submission.pending}>
          {i18n.t("email.subscribe")}
        </button>
      </form>
      <Show when={submission.result}>
        <div style="color: #03B000; margin-top: 24px;">{i18n.t("email.success")}</div>
      </Show>
      <Show when={submission.error}>
        <div style="color: #FF408F; margin-top: 24px;">{submission.error}</div>
      </Show>
    </section>
  )
}
