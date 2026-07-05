/**
 * Application-wide constants and configuration
 */
export const config = {
  // Base URL
  baseUrl: "https://mongolgpt.duckdns.org",

  // GitHub
  github: {
    repoUrl: "https://mongolgpt.duckdns.org",
    starsFormatted: {
      compact: "160K",
      full: "160,000",
    },
  },

  // Social links
  social: {
    twitter: "https://mongolgpt.duckdns.org",
    discord: "https://mongolgpt.duckdns.org",
  },

  // Static stats (used on landing page)
  stats: {
    contributors: "900",
    commits: "13,000",
    monthlyUsers: "7.5M",
  },
} as const
