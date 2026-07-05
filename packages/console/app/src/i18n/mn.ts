import type { Dict } from "./en"
import { dict as en } from "./en"

export const dict = {
  ...en,
  "nav.github": "GitHub",
  "nav.docs": "Баримт бичиг",
  "nav.data": "Өгөгдөл",
  "nav.changelog": "Өөрчлөлтийн түүх",
  "nav.discord": "Discord",
  "nav.x": "X",
  "nav.enterprise": "Байгууллага",
  "nav.zen": "Zen",
  "nav.go": "Go",
  "nav.login": "Нэвтрэх",
  "nav.free": "Татах",
  "nav.home": "Нүүр",
  "nav.openMenu": "Цэс нээх",
  "nav.getStartedFree": "Үнэгүй эхлэх",
  "nav.logoAlt": "MongolGPT",

  "nav.context.copyLogo": "Логог SVG хэлбэрээр хуулах",
  "nav.context.copyWordmark": "Бичвэр логог SVG хэлбэрээр хуулах",
  "nav.context.brandAssets": "Брэнд материал",

  "footer.github": "GitHub",
  "footer.docs": "Баримт бичиг",
  "footer.changelog": "Өөрчлөлтийн түүх",
  "footer.discord": "Discord",
  "footer.x": "X",

  "legal.brand": "Брэнд",
  "legal.privacy": "Нууцлал",
  "legal.terms": "Нөхцөл",

  "common.cancel": "Цуцлах",
  "common.creating": "Үүсгэж байна...",
  "common.create": "Үүсгэх",
  "common.contactUs": "Холбогдох",
  "common.videoUnsupported": "Таны browser видео дэмжихгүй байна.",
  "common.figure": "Зураг {{n}}.",
  "common.faq": "Түгээмэл асуулт",
  "common.learnMore": "Дэлгэрэнгүй",

  "email.title": "Шинэ бүтээгдэхүүн гарахад хамгийн түрүүнд мэдээрэй",
  "email.subtitle": "Эрт хандах жагсаалтад бүртгүүлнэ үү.",
  "email.placeholder": "Имэйл хаяг",
  "email.subscribe": "Бүртгүүлэх",
  "email.success": "Бараг боллоо, имэйлээ шалгаад баталгаажуулна уу",

  "notFound.title": "Олдсонгүй | MongolGPT",
  "notFound.heading": "404 - Хуудас олдсонгүй",
  "notFound.home": "Нүүр",
  "notFound.docs": "Баримт бичиг",
  "notFound.github": "GitHub",
  "notFound.discord": "Discord",
  "notFound.logoLightAlt": "MongolGPT цайвар лого",
  "notFound.logoDarkAlt": "MongolGPT бараан лого",

  "user.logout": "Гарах",

  "app.meta.description": "MongolGPT - Монгол-first AI coding agent.",
  "home.title": "MongolGPT | Монгол-first AI coding agent",

  "temp.title": "MongolGPT | Терминалд зориулсан AI coding agent",
  "temp.hero.title": "Терминалд зориулсан AI coding agent",
  "temp.getStarted": "Эхлэх",
  "temp.feature.native.title": "Native TUI",
  "temp.feature.native.body": "Хурдан, theme сольдог терминал UI",
  "temp.logoLightAlt": "MongolGPT цайвар лого",
  "temp.logoDarkAlt": "MongolGPT бараан лого",

  "home.banner.badge": "Шинэ",
  "home.banner.text": "Desktop app туршилтаар гарлаа",
  "home.banner.platforms": "Windows дээр",
  "home.banner.downloadNow": "Одоо татах",
  "home.banner.downloadBetaNow": "Desktop beta татах",

  "home.hero.title": "Монгол-first AI coding agent",
  "home.hero.subtitle.a": "Өөрийн provider-оо холбоно эсвэл боломжит загваруудаа ашиглана,",
  "home.hero.subtitle.b": "Claude, GPT, Gemini болон бусад загвартай ажиллана.",

  "home.install.ariaLabel": "Суулгах сонголтууд",

  "home.what.title": "MongolGPT гэж юу вэ?",
  "home.what.body": "MongolGPT нь terminal, IDE, desktop дээр код бичихэд туслах open source agent юм.",
  "home.what.lsp.title": "LSP дэмжинэ",
  "home.what.lsp.body": "Төсөлд тохирох LSP-үүдийг agent-д автоматаар ашиглуулна",
  "home.what.multiSession.title": "Олон session",
  "home.what.multiSession.body": "Нэг project дээр хэд хэдэн agent зэрэг ажиллуулна",
  "home.what.shareLinks.title": "Хуваалцах холбоос",
  "home.what.shareLinks.body": "Session-оо лавлагаа эсвэл debug хийхээр хуваалцана",
  "home.what.copilot.title": "GitHub Copilot",
  "home.what.copilot.body": "GitHub account-аараа нэвтэрч Copilot ашиглана",
  "home.what.chatgptPlus.title": "ChatGPT Plus/Pro",
  "home.what.chatgptPlus.body": "OpenAI account-аараа нэвтэрч ChatGPT Plus эсвэл Pro ашиглана",
  "home.what.anyModel.title": "Ямар ч загвар",
  "home.what.anyModel.body": "Models.dev-ээр дамжин олон provider болон local model ашиглана",
  "home.what.anyEditor.title": "Ямар ч editor",
  "home.what.anyEditor.body": "Terminal, desktop app, IDE extension хэлбэрээр ашиглана",
  "home.what.readDocs": "Docs унших",

  "home.growth.title": "Монгол-first AI coding agent",
  "home.growth.body":
    "MongolGPT нь GitHub дээрх public source, desktop build, docs, provider болон integration суурьтайгаар Монгол хэрэглэгчдэд зориулан хөгжиж байна.",
  "home.growth.githubStars": "GitHub star",
  "home.growth.contributors": "Хувь нэмэр оруулагч",
  "home.growth.monthlyDevs": "Сарын хэрэглэгч",

  "home.privacy.title": "Нууцлалыг эхэнд тавьсан",
  "home.privacy.body":
    "MongolGPT нь таны код болон context өгөгдлийг шаардлагагүйгээр хадгалахгүй байхаар бүтээгдсэн.",
  "home.privacy.learnMore": "Дэлгэрэнгүй унших",
  "home.privacy.link": "нууцлал",

  "home.faq.q1": "MongolGPT гэж юу вэ?",
  "home.faq.a1":
    "MongolGPT нь terminal, desktop app, IDE extension хэлбэрээр ашиглаж болох, ямар ч AI provider-той холбогдох AI coding agent юм.",
  "home.faq.q2": "MongolGPT-г яаж ашиглах вэ?",
  "home.faq.a2.before": "Эхлэх хамгийн амархан арга нь",
  "home.faq.a2.link": "танилцуулга",
  "home.faq.q3": "Заавал нэмэлт AI subscription хэрэгтэй юу?",
  "home.faq.a3.p1":
    "Заавал биш. Та local model ашиглаж болно, эсвэл өөрийн provider/API key/account-аа холбож болно.",
  "home.faq.a3.p2.beforeZen": "Мөн coding-д тохируулсан загваруудыг ашиглахын тулд",
  "home.faq.a3.p2.afterZen": " account үүсгэж болно.",
  "home.faq.a3.p3":
    "MongolGPT нь OpenAI, Anthropic, xAI зэрэг түгээмэл provider-уудтай ажиллах зорилготой.",
  "home.faq.a3.p4.beforeLocal": "Та мөн",
  "home.faq.a3.p4.localLink": "local model",
  "home.faq.q4": "Одоо байгаа AI subscription-оо ашиглаж болох уу?",
  "home.faq.a4.p1":
    "Болно. Claude Pro/Max, ChatGPT Plus/Pro, GitHub Copilot болон provider API key-үүдийг холбох суурьтай.",
  "home.faq.q5": "Зөвхөн терминал дээр ажилладаг уу?",
  "home.faq.a5.beforeDesktop": "Үгүй. MongolGPT нь",
  "home.faq.a5.desktop": "desktop",
  "home.faq.a5.and": "болон",
  "home.faq.a5.web": "web",
  "home.faq.q6": "MongolGPT хэдэн төгрөгийн үнэтэй вэ?",
  "home.faq.a6":
    "Open source source build нь үнэгүй. Provider ашиглавал тухайн provider-ийн төлбөр тусдаа гарч болно.",
  "home.faq.q7": "Өгөгдөл ба нууцлал яах вэ?",
  "home.faq.a7.p1": "Таны код болон context-ийг зөвхөн шаардлагатай workflow дээр боловсруулна.",
  "home.faq.a7.p2.beforeModels": "Дэлгэрэнгүйг",
  "home.faq.a7.p2.modelsLink": "загварууд",
  "home.faq.a7.p2.and": "болон",
  "home.faq.a7.p2.shareLink": "share page",
  "home.faq.q8": "MongolGPT open source уу?",
  "home.faq.a8.p1": "Тийм. Source code нь public GitHub дээр",
  "home.faq.a8.p2": "байрлаж,",
  "home.faq.a8.mitLicense": "MIT License",
  "home.faq.a8.p3": "-ийн дагуу ашиглаж, өөрчилж, хувь нэмэр оруулж болно.",

  "download.title": "MongolGPT | Татах",
  "download.meta.description": "MongolGPT desktop app болон source build татах",
  "download.hero.title": "MongolGPT татах",
  "download.hero.subtitle": "Одоогоор Windows x64 desktop build нийтлэгдсэн. Бусад package registry хараахан нийтлэгдээгүй.",
  "download.hero.button": "{{os}} татах",
  "download.section.terminal": "MongolGPT Terminal",
  "download.section.desktop": "MongolGPT Desktop (beta)",
  "download.section.extensions": "MongolGPT өргөтгөлүүд",
  "download.section.integrations": "MongolGPT интеграц",
  "download.action.download": "Татах",
  "download.action.install": "Суулгах",

  "download.platform.macosAppleSilicon": "macOS (Apple Silicon)",
  "download.platform.macosIntel": "macOS (Intel)",
  "download.platform.windowsX64": "Windows (x64)",
  "download.platform.linuxDeb": "Linux (.deb)",
  "download.platform.linuxRpm": "Linux (.rpm)",

  "download.faq.a3.beforeLocal":
    "Заавал биш. Төлбөртэй provider ашиглах бол subscription эсвэл API key хэрэгтэй. Харин",
  "download.faq.a3.localLink": "local model",
  "download.faq.a3.afterLocal.beforeZen": "үнэгүй ашиглах боломжтой. Мөн",
  "download.faq.a3.afterZen": " ашиглаж болно; MongolGPT нь OpenAI, Anthropic, xAI зэрэг provider-той ажиллана.",

  "download.faq.a5.p1": "MongolGPT source build нь үнэгүй.",
  "download.faq.a5.p2.beforeZen":
    "Нэмэлт төлбөр нь таны сонгосон model provider-оос хамаарна. Тогтвортой coding загвар ашиглах бол",
  "download.faq.a5.p2.afterZen": "-ийг сонгож болно.",

  "download.faq.a6.p1":
    "MongolGPT дотор share link үүсгэсэн үед л session өгөгдөл хуваалцах workflow-д орно.",
  "download.faq.a6.p2.beforeShare": "Дэлгэрэнгүйг",
  "download.faq.a6.shareLink": "share page",

  "enterprise.title": "MongolGPT | Байгууллагын шийдэл",
  "enterprise.meta.description": "MongolGPT байгууллагын шийдлийн талаар холбогдох",
  "enterprise.hero.title": "Таны код таных хэвээр",
  "enterprise.hero.body1":
    "MongolGPT-г байгууллагын дотоод орчин, SSO, internal AI gateway-тэй нийцүүлэн ажиллуулах зорилготой.",
  "enterprise.hero.body2": "Танд яаж туслахыг бидэнд хэлээрэй.",
} satisfies Dict
