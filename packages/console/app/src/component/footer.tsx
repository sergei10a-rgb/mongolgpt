import { createMemo } from "solid-js"
import { config } from "~/config"
import { useLanguage } from "~/context/language"
import { useI18n } from "~/context/i18n"
import { resolveCommunityLink } from "~/lib/community-link"

export function Footer() {
  const language = useLanguage()
  const i18n = useI18n()
  const community = createMemo(resolveCommunityLink)
  const communityIsExternal = /^https?:\/\//i.test(community().href)
  return (
    <footer data-component="footer">
      <div data-slot="cell">
        <a href={language.route("/docs")}>{i18n.t("footer.docs")}</a>
      </div>
      <div data-slot="cell">
        <a href={language.route("/download")}>Татах</a>
      </div>
      <div data-slot="cell">
        <a href={language.route("/pricing")}>{i18n.t("nav.pricing")}</a>
      </div>
      <div data-slot="cell">
        <a href={language.route("/support")}>{i18n.t("footer.support")}</a>
      </div>
      <div data-slot="cell">
        <a
          href={community().href}
          target={communityIsExternal ? "_blank" : undefined}
          rel={communityIsExternal ? "noreferrer" : undefined}
        >
          {i18n.t(`footer.${community().kind}`)}
        </a>
      </div>
      <div data-slot="cell">
        <a href={config.github.repoUrl} target="_blank" rel="noreferrer">
          {i18n.t("footer.github")}
        </a>
      </div>
    </footer>
  )
}
