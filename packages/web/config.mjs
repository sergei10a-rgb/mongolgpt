const localUrl = `http://localhost:${process.env.PORT || "4321"}`
const url = process.env.MONGOLGPT_PUBLIC_URL?.trim() || localUrl
const consoleUrl = process.env.MONGOLGPT_CONSOLE_URL?.trim() || "http://localhost:3000"

export default {
  url,
  console: consoleUrl,
  email: process.env.MONGOLGPT_CONTACT_EMAIL?.trim() || "",
  github: "https://github.com/sergei10a-rgb/mongolgpt",
  discord:
    process.env.MONGOLGPT_COMMUNITY_URL?.trim() || "https://github.com/sergei10a-rgb/mongolgpt/discussions",
  headerLinks: [
    { name: "Нүүр", url: "/" },
    { name: "Баримт бичиг", url: "/docs/" },
  ],
}
