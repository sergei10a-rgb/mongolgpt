import { createMemo } from "solid-js"
import { resolveCommunityLink } from "~/lib/community-link"
import { config } from "~/config"
import { useLanguage } from "~/context/language"
import { useI18n } from "~/context/i18n"

export function Footer() {
  const language = useLanguage()
  const i18n = useI18n()
  const community = createMemo(resolveCommunityLink)
  return (
    <footer data-component="footer">
      <div data-slot="cell">
        <a href={config.github.repoUrl} target="_blank">
          {i18n.t("footer.github")}
        </a>
      </div>
      <div data-slot="cell">
        <a href={language.route("/docs")}>{i18n.t("footer.docs")}</a>
      </div>
      <div data-slot="cell">
        <a href={language.route("/download")}>{i18n.t("nav.free")}</a>
      </div>
      <div data-slot="cell">
        <a href={language.route("/changelog")}>{i18n.t("footer.changelog")}</a>
      </div>
      <div data-slot="cell">
        <a href={community().href}>{i18n.t(`footer.${community().kind}`)}</a>
      </div>
      <div data-slot="cell">
        <a href={config.social.support}>{i18n.t("footer.support")}</a>
      </div>
    </footer>
  )
}
