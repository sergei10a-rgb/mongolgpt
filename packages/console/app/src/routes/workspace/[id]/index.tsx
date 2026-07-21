import { Show } from "solid-js"
import { A, createAsync, useParams } from "@solidjs/router"
import { NewUserSection } from "./new-user-section"
import { ModelSection } from "./model-section"
import { ProviderSection } from "./provider-section"
import logoLight from "~/asset/logo-ornate-light.svg"
import logoDark from "~/asset/logo-ornate-dark.svg"
import { querySessionInfo } from "../common"
import { useI18n } from "~/context/i18n"
import { useLanguage } from "~/context/language"

export default function () {
  const params = useParams()
  const i18n = useI18n()
  const language = useLanguage()
  const userInfo = createAsync(() => querySessionInfo(params.id!))

  return (
    <div data-page="workspace-[id]">
      <section data-component="header-section">
        <picture data-slot="product-logo">
          <source srcset={logoDark} media="(prefers-color-scheme: dark)" />
          <img src={logoLight} alt="MongolGPT - AI кодын агент" width="167" height="30" />
        </picture>
        <p>
          <span>
            {i18n.t("workspace.home.banner.beforeLink")}{" "}
            <a target="_blank" href={language.route("/docs/models")}>
              {i18n.t("common.learnMore")}
            </a>
            .
          </span>
          <Show when={userInfo()?.isAdmin}>
            <span data-slot="billing-info">
              <A data-component="button" data-color="primary" data-size="sm" href={`/workspace/${params.id}/billing`}>
                Багц ба төлбөр
              </A>
            </span>
          </Show>
        </p>
      </section>

      <div data-slot="sections">
        <NewUserSection />
        <ModelSection />
        <Show when={userInfo()?.isAdmin}>
          <ProviderSection />
        </Show>
      </div>
    </div>
  )
}
