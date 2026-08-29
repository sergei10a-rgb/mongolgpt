import "./index.css"
import { Meta, Title } from "@solidjs/meta"
import { A } from "@solidjs/router"
import { For } from "solid-js"
import productSession from "../asset/lander/mongolgpt-product-session.png"
import { Faq } from "~/component/faq"
import { Footer } from "~/component/footer"
import { Header } from "~/component/header"
import { Legal } from "~/component/legal"
import { LocaleLinks } from "~/component/locale-links"
import { config } from "~/config"
import { useI18n } from "~/context/i18n"
import { useLanguage } from "~/context/language"

const productPillars = [
  {
    title: "Шууд ашиглах үндсэн орчин",
    body: "Вэб, Windows ширээний програм, командын мөрийн нэвтрэлт, баримт бичиг болон тусламжийн хэсэг шууд нээлттэй.",
    links: [
      { label: "Нэвтрэх", href: "/auth" },
      { label: "Ширээний програм татах", href: "/download" },
      { label: "Командын мөрийн заавар", href: "/docs/cli" },
    ],
  },
  {
    title: "Үнэгүй горим ба өөрийн загвар",
    body: "Үнэгүй автомат горимоор эхэлж, OpenRouter, NVIDIA NIM, OpenAI-д нийцсэн API хаяг, Ollama, LM Studio зэргийг холбоно.",
    links: [
      { label: "Үнийн багц", href: "/pricing" },
      { label: "Үйлчилгээ үзүүлэгчдийн заавар", href: "/docs/providers/" },
      { label: "Бүртгэл нээх", href: "/auth" },
    ],
  },
  {
    title: "MCP, ур чадвар, өргөтгөлийн нийцэл",
    body: "MCP, ур чадвар, өргөтгөлүүдээ заавар болон ширээний програмын ажлын урсгалтай холбож, нэг бүртгэл дээрээ ашиглах суурьтай.",
    links: [
      { label: "Заавар", href: "/docs" },
      { label: "GitHub", href: config.github.repoUrl, external: true },
      { label: "Тусламж", href: "/support" },
    ],
  },
] as const

const experienceRows = [
  {
    label: "Вэб",
    title: "Хөтөчөөсөө шууд эхэлнэ",
    body: "Нэвтэрмэгц үнэгүй автомат горим, ажлын орон зай, хэрэглээ, үйлчилгээ үзүүлэгчийн тохиргоогоо нэг дороос ашиглана.",
    href: "/auth",
    action: "Вэб програм нээх",
  },
  {
    label: "Ширээний програм",
    title: "Дотоод кодын сан, тушаалын мөртэй ажиллана",
    body: "Windows-ийн ширээний хувилбар нь MongolGPT нэрээр сууж, ижил бүртгэлийн урсгалаар ажиллана.",
    href: "/download",
    action: "Ширээний програм татах",
  },
  {
    label: "Командын мөр",
    title: "Терминал төвтэй ажлаа салгахгүй",
    body: "Командын мөр, төхөөрөмж болон хөтчийн нэвтрэлт, үйлчилгээ үзүүлэгчийн тохиргоог Монгол заавраас дагана.",
    href: "/docs/cli",
    action: "Командын мөрийн заавар үзэх",
  },
] as const

const accountRows = [
  {
    title: "Нэг бүртгэл, бүх орчин",
    body: "Нэг MongolGPT бүртгэл дээрээ вэб, ширээний програм, командын мөрийн нэвтрэлт, багц, хэрэглээний мэдээллээ төвлөрүүлнэ.",
  },
  {
    title: "Өөрийн API түлхүүр ба дотоод загвар",
    body: "Өөрийн OpenRouter, NVIDIA NIM, OpenAI-д нийцсэн API хаяг, Ollama, LM Studio холболтоо сонгож ашиглана.",
  },
  {
    title: "Үнэн зөв төлөв ба тусламж",
    body: "Төлбөрийн идэвхжил, суулгалт, бүртгэл болон API асуудлаа үнийн багц, заавар, тусламжийн хэсгээс шалгаж шийднэ.",
  },
] as const

const launchActions = [
  {
    title: "Нэвтрэх",
    body: "MongolGPT бүртгэлээрээ орж үнэгүй автомат горим болон ажлын орон зайгаа эхлүүлнэ.",
    href: "/auth",
  },
  {
    title: "Татах",
    body: "Ширээний програмын суулгагч болон үйлдлийн системдээ тохирох хувилбарыг эндээс авна.",
    href: "/download",
  },
  {
    title: "Заавар",
    body: "Командын мөр, үйлчилгээ үзүүлэгч, нэвтрэлт, алдаа оношлох болон нийцлийн зааврыг эндээс харна.",
    href: "/docs",
  },
  {
    title: "Үнийн багц",
    body: "Үнэгүй хэрэглээ, багцын хязгаар болон төлбөрийн идэвхжлийн өнөөгийн мэдээллийг нэг дороос үзнэ.",
    href: "/pricing",
  },
] as const

const trustRows = [
  {
    title: "Нууцлал ба өгөгдөл",
    body: "Үнэгүй автомат горим, хуваалцах холбоос, өөрийн API түлхүүрийн урсгал бүрийг ил тод тайлбарласан. Нууцлалын бодлого, өгөгдлийн хэрэглээг шууд шалгаж болно.",
    href: "/legal/privacy-policy",
    action: "Нууцлал унших",
  },
  {
    title: "Нөхцөл ба эрхийн мэдээлэл",
    body: "Үйлчилгээний нөхцөл, брэндийн материал, нээлттэй эхийн лиценз болон хэрэглэгчийн эрхтэй холбоотой мэдээлэл нийтэд нээлттэй байна.",
    href: "/legal/terms-of-service",
    action: "Нөхцөл харах",
  },
  {
    title: "Ил тод хөгжүүлэлт",
    body: "GitHub репо, баримт бичиг, таталт, тусламжийн урсгалууд нэг брэнд дор холбогдсон тул хэрэглэгч хаанаас юу авахаа төөрөхгүй.",
    href: "/brand",
    action: "Брэндийн материал",
  },
] as const

const readinessRows = [
  {
    title: "Одоо ашиглах боломжтой",
    body: "Вэб нэвтрэлт, Windows ширээний програм таталт, командын мөрийн заавар, үнэгүй автомат горимын эхлэл, тусламж ба баримт бичгийн урсгал одооноос хэрэглэж болно.",
    href: "/download",
    action: "Татах ба эхлэх",
  },
  {
    title: "Холбож ашиглах боломжууд",
    body: "Өөрийн API түлхүүр, дотоод загвар, MCP, ур чадвар, өргөтгөлийн тохиргоонуудыг өөрийн хэрэгцээнд нийцүүлэн заавраар тохируулж ашиглана.",
    href: "/docs/providers/",
    action: "Тохиргооны заавар",
  },
  {
    title: "Төлбөр ба нэмэлт тохиргоо",
    body: "Төлбөрийн идэвхжил болон зарим нэмэлт холболт нь багц, орчин, тохиргооноос шалтгаална. Дэлгэрэнгүйг үнийн багц, тусламжаас баталгаажуулна.",
    href: "/support",
    action: "Төлөв шалгах",
  },
] as const

export default function Home() {
  const i18n = useI18n()
  const language = useLanguage()

  return (
    <main data-page="mongolgpt" data-view="home">
      <Title>{i18n.t("home.title")}</Title>
      <LocaleLinks path="/" />
      <Meta property="og:image" content="/social-share.png" />
      <Meta name="twitter:image" content="/social-share.png" />

      <div data-component="container">
        <Header />

        <div data-component="content">
          <section data-component="hero">
            <div data-component="desktop-app-banner">
              <span data-slot="badge">{i18n.t("home.banner.badge")}</span>
              <div data-slot="content">
                <span data-slot="text">
                  {i18n.t("home.banner.text")}
                  <span data-slot="platforms"> {i18n.t("home.banner.platforms")}</span>.
                </span>
                <A href={language.route("/download")} data-slot="link">
                  {i18n.t("home.banner.downloadNow")}
                </A>
                <A href={language.route("/download")} data-slot="link-mobile">
                  {i18n.t("home.banner.downloadBetaNow")}
                </A>
              </div>
            </div>

            <div data-component="hero-grid">
              <div data-slot="hero-copy">
                <p data-slot="eyebrow">Монгол хэрэглэгчийн хиймэл оюуны кодын агент</p>
                <h1>MongolGPT</h1>
                <p data-slot="lede">
                  Код, командын мөр, үйлчилгээ үзүүлэгч, бүртгэл, заавар, вэб болон ширээний програмын хэрэглээг нэг
                  MongolGPT орчинд Монгол хэлээр холбоно.
                </p>
                <p data-slot="supporting-copy">
                  Үнэгүй автомат горимоор шууд эхэлнэ. Хүсвэл өөрийн API түлхүүр, OpenAI-д нийцсэн API хаяг, OpenRouter,
                  NVIDIA NIM, Ollama, LM Studio болон дотоод загвараа холбоно.
                </p>
                <div data-slot="hero-actions">
                  <A href={language.route("/auth")} data-variant="primary">
                    Эхлэх
                  </A>
                  <A href={language.route("/pricing")} data-variant="secondary">
                    Үнийн багц
                  </A>
                  <A href={language.route("/docs")} data-variant="ghost">
                    Заавар
                  </A>
                </div>
                <ul data-slot="hero-points">
                  <li>Вэб, ширээний програм, командын мөрт нэг бүртгэл</li>
                  <li>Үнэгүй автомат горим, өөрийн API түлхүүр, дотоод загвар</li>
                  <li>MCP, ур чадвар, өргөтгөлтэй нийцэх ажлын урсгал</li>
                </ul>
                <dl data-slot="hero-facts" aria-label="Бүтээгдэхүүний гол төлөв">
                  <div>
                    <dt>Бүртгэл</dt>
                    <dd>Нэг бүртгэл</dd>
                  </div>
                  <div>
                    <dt>Орчин</dt>
                    <dd>Вэб, ширээний програм, командын мөр</dd>
                  </div>
                  <div>
                    <dt>Эхлэл</dt>
                    <dd>Үнэгүй горим</dd>
                  </div>
                  <div>
                    <dt>Тохиргоо</dt>
                    <dd>API түлхүүр, дотоод загвар</dd>
                  </div>
                </dl>
              </div>

              <div data-slot="hero-visual">
                <div data-slot="visual-frame">
                  <img
                    src={productSession}
                    alt={i18n.t("home.product.alt")}
                    width="1440"
                    height="810"
                    loading="eager"
                  />
                </div>
                <div data-slot="visual-caption">
                  <span>Бүтээгдэхүүний бодит харагдац</span>
                  <p>
                    MongolGPT-ийн бодит дэлгэц дээр нэвтрэлт, үнэгүй горим, кодын хяналт, ажлын орон зайг харуулж байна.
                  </p>
                </div>
              </div>
            </div>

            <div data-component="hero-nav" aria-label="Үндсэн хэсгүүд">
              <A href={language.route("/auth")}>Бүртгэл</A>
              <A href={language.route("/download")}>Ширээний програм</A>
              <A href={language.route("/docs/cli")}>Командын мөр</A>
              <A href={language.route("/docs/providers/")}>Үйлчилгээ үзүүлэгчид</A>
              <A href={language.route("/pricing")}>Үнийн багц</A>
            </div>
          </section>

          <section data-component="pillar-band" aria-label="Бүтээгдэхүүний үндсэн боломжууд">
            <For each={productPillars}>
              {(pillar) => (
                <article data-component="pillar-card">
                  <h2>{pillar.title}</h2>
                  <p>{pillar.body}</p>
                  <div data-slot="card-links">
                    <For each={pillar.links}>
                      {(link) =>
                        "external" in link && link.external ? (
                          <a href={link.href} target="_blank" rel="noreferrer">
                            {link.label}
                          </a>
                        ) : (
                          <A href={language.route(link.href)}>{link.label}</A>
                        )
                      }
                    </For>
                  </div>
                </article>
              )}
            </For>
          </section>

          <section data-component="readiness-band" aria-label="Үйлчилгээний бодит төлөв">
            <div data-slot="section-heading">
              <p data-slot="eyebrow">Бодит төлөв</p>
              <h2>Шууд эхлэхэд хэрэгтэй товч мэдээлэл</h2>
              <p>
                Юу нь шууд бэлэн, юуг бүртгэл эсвэл үйлчилгээ үзүүлэгчийн тохиргоотой уялдуулж ашиглахыг тодорхой
                харууллаа.
              </p>
            </div>
            <div data-component="readiness-grid">
              <For each={readinessRows}>
                {(row) => (
                  <article data-component="readiness-card">
                    <h3>{row.title}</h3>
                    <p>{row.body}</p>
                    <A href={language.route(row.href)}>{row.action}</A>
                  </article>
                )}
              </For>
            </div>
          </section>

          <section data-component="experience-band">
            <div data-slot="section-heading">
              <p data-slot="eyebrow">Хэрэглээ</p>
              <h2>Нэг бүтээгдэхүүн, өөр өөр ажлын орчин</h2>
              <p>
                Нэг ажлыг хөтчөөсөө эхлүүлээд ширээний програм эсвэл терминал руу шилжихэд бүртгэл, заавар, үйлчилгээ
                үзүүлэгчийн тохиргоо, тусламжийн холбоосууд салангид болохгүй.
              </p>
            </div>
            <div data-component="experience-list">
              <For each={experienceRows}>
                {(row) => (
                  <article data-component="experience-row">
                    <div>
                      <span data-slot="row-label">{row.label}</span>
                      <h3>{row.title}</h3>
                    </div>
                    <p>{row.body}</p>
                    <A href={language.route(row.href)}>{row.action}</A>
                  </article>
                )}
              </For>
            </div>
          </section>

          <section data-component="account-band">
            <div data-slot="section-heading">
              <p data-slot="eyebrow">Бүртгэл ба загварууд</p>
              <h2>Үнэгүй горимоор эхэлж, хэрэгтэй үедээ өөрийн хэрэглүүрүүдээ холбоно</h2>
              <p>
                Анхдагч урсгал нь энгийн. Нарийвчилсан хэрэгцээтэй хэрэглэгч өөрийн үйлчилгээ үзүүлэгч, API түлхүүр,
                дотоод загвар болон бүртгэлийн төлөвөө нэг дороос хянаж өргөтгөнө.
              </p>
            </div>
            <div data-component="account-grid">
              <For each={accountRows}>
                {(row) => (
                  <article data-component="account-card">
                    <h3>{row.title}</h3>
                    <p>{row.body}</p>
                  </article>
                )}
              </For>
            </div>
          </section>

          <section data-component="trust-band" aria-label="Итгэлцэл, нууцлал, эрх зүйн мэдээлэл">
            <div data-slot="section-heading">
              <p data-slot="eyebrow">Итгэлцэл</p>
              <h2>Нууцлал, эрх зүйн мэдээллийг нэг дороос шалгана</h2>
              <p>
                MongolGPT-ийн нийтийн сайт нь нэвтрэх, татах, баримт бичиг үзэхээс гадна нууцлал, нөхцөл, брэндийн
                материал болон нээлттэй эхийн мэдээллийг ойлгомжтой байлгана.
              </p>
            </div>
            <div data-component="trust-grid">
              <For each={trustRows}>
                {(row) => (
                  <article data-component="trust-card">
                    <h3>{row.title}</h3>
                    <p>{row.body}</p>
                    <A href={language.route(row.href)}>{row.action}</A>
                  </article>
                )}
              </For>
            </div>
          </section>

          <section data-component="launch-band">
            <div data-slot="section-heading">
              <p data-slot="eyebrow">Дараагийн алхам</p>
              <h2>Туршиж эхлэх үндсэн хэсгүүд</h2>
              <p>Нэвтрэх, татах, заавар унших, үнийн багцаа сонгох хэсэг рүү шууд орно.</p>
            </div>
            <div data-component="launch-grid">
              <For each={launchActions}>
                {(action) => (
                  <article data-component="launch-card">
                    <h3>{action.title}</h3>
                    <p>{action.body}</p>
                    <A href={language.route(action.href)}>{action.title}</A>
                  </article>
                )}
              </For>
            </div>
          </section>

          <section data-component="faq-band">
            <div data-slot="section-heading">
              <p data-slot="eyebrow">Тусламж</p>
              <h2>{i18n.t("common.faq")}</h2>
            </div>
            <ul>
              <li>
                <Faq question={i18n.t("home.faq.q1")}>{i18n.t("home.faq.a1")}</Faq>
              </li>
              <li>
                <Faq question={i18n.t("home.faq.q2")}>
                  {i18n.t("home.faq.a2.before")} <a href={language.route("/docs")}>{i18n.t("home.faq.a2.link")}</a>.
                </Faq>
              </li>
              <li>
                <Faq question={i18n.t("home.faq.q3")}>
                  {i18n.t("home.faq.a3.p1")} {i18n.t("home.faq.a3.p2.beforePlans")}{" "}
                  <A href={language.route("/pricing")}>{i18n.t("home.faq.a3.p2.plansLink")}</A>
                  {i18n.t("home.faq.a3.p2.afterPlans")} {i18n.t("home.faq.a3.p3")}{" "}
                  {i18n.t("home.faq.a3.p4.beforeLocal")}{" "}
                  <a href={language.route("/docs/providers/#lm-studio")} target="_blank" rel="noreferrer">
                    {i18n.t("home.faq.a3.p4.localLink")}
                  </a>
                  .
                </Faq>
              </li>
              <li>
                <Faq question={i18n.t("home.faq.q4")}>
                  {i18n.t("home.faq.a4.p1")}{" "}
                  <a href={language.route("/docs/providers/#directory")}>{i18n.t("common.learnMore")}</a>.
                </Faq>
              </li>
              <li>
                <Faq question={i18n.t("home.faq.q5")}>
                  {i18n.t("home.faq.a5.beforeDesktop")}{" "}
                  <a href={language.route("/download")}>{i18n.t("home.faq.a5.desktop")}</a> {i18n.t("home.faq.a5.and")}{" "}
                  <a href={language.route("/docs/web")}>{i18n.t("home.faq.a5.web")}</a>!
                </Faq>
              </li>
              <li>
                <Faq question={i18n.t("home.faq.q6")}>
                  {i18n.t("home.faq.a6.beforePricing")}{" "}
                  <A href={language.route("/pricing")}>{i18n.t("home.faq.a6.pricingLink")}</A>
                  {i18n.t("home.faq.a6.afterPricing")}
                </Faq>
              </li>
            </ul>
          </section>
        </div>

        <Footer />
      </div>
      <Legal />
    </main>
  )
}
