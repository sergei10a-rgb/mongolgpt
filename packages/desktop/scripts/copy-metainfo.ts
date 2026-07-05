import { resolveChannel } from "./utils"

const arg = process.argv[2]
const channel = arg === "dev" || arg === "beta" || arg === "prod" ? arg : resolveChannel()

const appId = channel === "prod" ? "org.mongolgpt.desktop" : `org.mongolgpt.desktop.${channel}`
const productName = channel === "prod" ? "MongolGPT" : `MongolGPT ${channel.charAt(0).toUpperCase() + channel.slice(1)}`
const summary = `Монгол хэлтэй, нээлттэй эхийн AI coding agent${channel !== "prod" ? ` (${channel})` : ""}`

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<component type="desktop-application">
  <id>${appId}</id>

  <metadata_license>CC0-1.0</metadata_license>
  <project_license>MIT</project_license>

  <name>${productName}</name>
  <summary>${summary}</summary>

  <developer id="org.mongolgpt">
    <name>MongolGPT</name>
  </developer>

  <description>
    <p>
      MongolGPT нь ямар ч AI модельтой код бичих, ажиллуулахад туслах Монгол хэлтэй нээлттэй эхийн агент.
    </p>
  </description>

  <launchable type="desktop-id">${appId}.desktop</launchable>

  <content_rating type="oars-1.1" />

  <url type="bugtracker">https://github.com/sergei10a-rgb/mongolgpt/issues</url>
  <url type="homepage">https://mongolgpt.duckdns.org</url>
  <url type="vcs-browser">https://github.com/sergei10a-rgb/mongolgpt</url>

  <screenshots>
    <screenshot type="default">
      <image>https://mongolgpt.duckdns.org/og.png</image>
    </screenshot>
  </screenshots>
</component>
`

await Bun.write(`resources/${appId}.metainfo.xml`, xml)
console.log(`Generated metainfo for ${channel} at resources/${appId}.metainfo.xml`)
