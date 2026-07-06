const stage = process.env.SST_STAGE || "dev"

export default {
  url: stage === "production" ? "https://mongolgpt.duckdns.org" : `https://${stage}.mongolgpt.duckdns.org`,
  console:
    stage === "production" ? "https://mongolgpt.duckdns.org/auth" : `https://${stage}.mongolgpt.duckdns.org/auth`,
  email: "support@mongolgpt.duckdns.org",
  github: "https://github.com/sergei10a-rgb/mongolgpt",
  discord: "https://mongolgpt.duckdns.org/discord",
  headerLinks: [
    { name: "Нүүр", url: "/" },
    { name: "Баримт бичиг", url: "/docs/" },
  ],
}
