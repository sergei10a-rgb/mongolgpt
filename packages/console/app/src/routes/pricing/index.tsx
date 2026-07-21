import "../index.css"
import "./index.css"
import { Meta, Title } from "@solidjs/meta"
import { PaymentPlanCatalogSchema } from "@mongolgpt/console-core/payment-checkout.js"
import { Resource } from "@mongolgpt/console-resource"
import { A, createAsync, query } from "@solidjs/router"
import { createMemo, For } from "solid-js"
import { Footer } from "~/component/footer"
import { Header } from "~/component/header"
import { Legal } from "~/component/legal"
import { LocaleLinks } from "~/component/locale-links"
import { config } from "~/config"
import { useI18n } from "~/context/i18n"
import { useLanguage } from "~/context/language"

const getPricingCatalog = query(async () => {
  "use server"
  try {
    const payment = Resource.PaymentConfig
    const catalog = PaymentPlanCatalogSchema.safeParse(JSON.parse(payment.planCatalog))
    return {
      enabled: payment.enabled === true && catalog.success,
      environment: payment.environment === "production" ? ("production" as const) : ("sandbox" as const),
      catalog: catalog.success ? catalog.data : null,
    }
  } catch {
    return {
      enabled: false,
      environment: "sandbox" as const,
      catalog: null,
    }
  }
}, "pricing.catalog.get")

export default function Pricing() {
  const i18n = useI18n()
  const language = useLanguage()
  const pricing = createAsync(() => getPricingCatalog())
  const formatAmount = (amount: number | undefined) => {
    if (amount === undefined) return i18n.t("pricing.price.configuring")
    return new Intl.NumberFormat(language.tag(language.locale()), {
      style: "currency",
      currency: "MNT",
      maximumFractionDigits: 0,
    }).format(amount)
  }
  const plans = createMemo(() => {
    const catalog = pricing()?.catalog
    return [
      {
        id: "free",
        name: i18n.t("pricing.plan.free.name"),
        description: i18n.t("pricing.plan.free.description"),
        price: i18n.t("pricing.price.free"),
        action: i18n.t("pricing.cta.free"),
        features: [
          i18n.t("pricing.feature.freeAuto"),
          i18n.t("pricing.feature.byok"),
          i18n.t("pricing.feature.localModels"),
          i18n.t("pricing.feature.allClients"),
        ],
      },
      {
        id: "basic",
        name: i18n.t("pricing.plan.basic.name"),
        description: i18n.t("pricing.plan.basic.description"),
        price: formatAmount(catalog?.basic.amount),
        action: i18n.t("pricing.cta.paid"),
        features: [
          i18n.t("pricing.feature.sharedAccount"),
          i18n.t("pricing.feature.usageTracking"),
          i18n.t("pricing.feature.basicQuota"),
          i18n.t("pricing.feature.qpayBonum"),
        ],
      },
      {
        id: "pro",
        name: i18n.t("pricing.plan.pro.name"),
        description: i18n.t("pricing.plan.pro.description"),
        price: formatAmount(catalog?.pro.amount),
        action: i18n.t("pricing.cta.paid"),
        features: [
          i18n.t("pricing.feature.sharedAccount"),
          i18n.t("pricing.feature.usageTracking"),
          i18n.t("pricing.feature.proQuota"),
          i18n.t("pricing.feature.qpayBonum"),
        ],
      },
      {
        id: "max",
        name: i18n.t("pricing.plan.max.name"),
        description: i18n.t("pricing.plan.max.description"),
        price: formatAmount(catalog?.max.amount),
        action: i18n.t("pricing.cta.paid"),
        features: [
          i18n.t("pricing.feature.sharedAccount"),
          i18n.t("pricing.feature.usageTracking"),
          i18n.t("pricing.feature.maxQuota"),
          i18n.t("pricing.feature.qpayBonum"),
        ],
      },
    ] as const
  })

  return (
    <main data-page="mongolgpt" data-view="pricing">
      <Title>{i18n.t("pricing.meta.title")}</Title>
      <Meta name="description" content={i18n.t("pricing.meta.description")} />
      <LocaleLinks path="/pricing" />
      <Meta property="og:type" content="website" />
      <Meta property="og:url" content={`${config.baseUrl}${language.route("/pricing")}`} />
      <Meta property="og:title" content={i18n.t("pricing.meta.title")} />
      <Meta property="og:description" content={i18n.t("pricing.meta.description")} />
      <Meta property="og:image" content="/social-share.png" />
      <Meta name="twitter:card" content="summary_large_image" />
      <Meta name="twitter:title" content={i18n.t("pricing.meta.title")} />
      <Meta name="twitter:description" content={i18n.t("pricing.meta.description")} />
      <Meta name="twitter:image" content="/social-share.png" />

      <div data-component="container">
        <Header />
        <div data-component="content">
          <section data-component="pricing-intro">
            <p data-slot="eyebrow">MongolGPT</p>
            <h1>{i18n.t("pricing.title")}</h1>
            <p>{i18n.t("pricing.subtitle")}</p>
          </section>

          <section data-component="pricing-plans" aria-label={i18n.t("pricing.plans.ariaLabel")}>
            <For each={plans()}>
              {(plan) => (
                <article data-component="pricing-plan" data-plan={plan.id}>
                  <div data-slot="plan-heading">
                    <h2>{plan.name}</h2>
                    <p>{plan.description}</p>
                  </div>
                  <div data-slot="price">
                    <strong>{plan.price}</strong>
                    <span>
                      {plan.id === "free" ? i18n.t("pricing.price.forever") : i18n.t("pricing.price.monthly")}
                    </span>
                  </div>
                  <ul>
                    <For each={plan.features}>
                      {(feature) => (
                        <li>
                          <span aria-hidden="true">✓</span>
                          {feature}
                        </li>
                      )}
                    </For>
                  </ul>
                  <A href="/auth" data-slot="plan-action">
                    {plan.action}
                  </A>
                </article>
              )}
            </For>
          </section>

          <section data-component="pricing-notes">
            <p>{i18n.t("pricing.note.limits")}</p>
            <p>{i18n.t("pricing.note.payment")}</p>
          </section>
        </div>
        <Footer />
      </div>
      <Legal />
    </main>
  )
}
