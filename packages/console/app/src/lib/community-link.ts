import { config } from "~/config"

export type CommunityLinkKind = "community" | "discord"

export function resolveCommunityLink() {
  return {
    kind: classifyCommunityUrl(config.social.discord),
    href: config.social.discord,
  }
}

function classifyCommunityUrl(url: string): CommunityLinkKind {
  if (/^https?:\/\/([^/]+\.)?discord(?:app)?\.com(?:\/|$)/i.test(url)) return "discord"
  return "community"
}
