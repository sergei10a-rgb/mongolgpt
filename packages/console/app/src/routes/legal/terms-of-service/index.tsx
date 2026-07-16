import "../../brand/index.css"
import "./index.css"
import { Title, Meta } from "@solidjs/meta"
import { Header } from "~/component/header"
import { Footer } from "~/component/footer"
import { Legal } from "~/component/legal"
import { LocaleLinks } from "~/component/locale-links"
import { config } from "~/config"

export default function TermsOfService() {
  return (
    <main data-page="legal">
      <Title>MongolGPT | Үйлчилгээний нөхцөл</Title>
      <LocaleLinks path="/legal/terms-of-service" />
      <Meta name="description" content="MongolGPT үйлчилгээний нөхцөлийн нээлтийн өмнөх тэмдэглэл" />
      <div data-component="container">
        <Header />

        <div data-component="content">
          <section data-component="brand-content">
            <article data-component="terms-of-service">
              <h1>Үйлчилгээний нөхцөл</h1>
              <p class="effective-date">Нээлтийн өмнөх төлөв</p>
              <p>
                Энэ хуудас нь үйлдвэрлэлийн үйлчилгээний нөхцөл биш. MongolGPT SaaS хараахан нийтэд байршаагүй,
                хууль эрх зүйн баримт бичиг эцэслэгдээгүй байна.
              </p>
              <p>
                Одоогоор MongolGPT-ийн эх код, асуудал, хэлэлцүүлгийг GitHub сангаар дамжуулан удирдаж байна.
                Дэлгэрэнгүй мэдээлэл эсвэл санал хүсэлт илгээх бол{" "}
                <a href={config.github.repoUrl}>MongolGPT GitHub сан</a>-г ашиглана уу.
              </p>
            </article>
          </section>
        </div>

        <Footer />
        <Legal />
      </div>
    </main>
  )
}
