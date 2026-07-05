/**
 * Application-wide constants and configuration
 */
export const config = {
  // Base URL
  baseUrl: "https://mongolgpt.duckdns.org",

  // GitHub
  github: {
    repoUrl: "https://github.com/sergei10a-rgb/mongolgpt",
    starsFormatted: {
      compact: "0",
      full: "0",
    },
  },

  // Social links
  social: {
    twitter: "https://mongolgpt.duckdns.org",
    discord: "https://mongolgpt.duckdns.org",
  },

  // Static stats (used on landing page)
  stats: {
    contributors: "1",
    commits: "5",
    monthlyUsers: "0",
  },
} as const
