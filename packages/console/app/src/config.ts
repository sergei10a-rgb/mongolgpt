export const repositoryUrl = "https://github.com/sergei10a-rgb/mongolgpt"
const publicUrl = import.meta.env.VITE_MONGOLGPT_PUBLIC_URL?.trim() || repositoryUrl
export const supportUrl = import.meta.env.VITE_MONGOLGPT_SUPPORT_URL?.trim() || "/support"

/**
 * Application-wide constants and configuration
 */
export const config = {
  // Base URL
  baseUrl: publicUrl,

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
    support: supportUrl,
    discord: import.meta.env.VITE_MONGOLGPT_COMMUNITY_URL?.trim() || `${repositoryUrl}/discussions`,
  },

  // Static stats (used on landing page)
  stats: {
    contributors: "1",
    commits: "5",
    monthlyUsers: "0",
  },
} as const
