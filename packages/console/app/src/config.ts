export const repositoryUrl = "https://github.com/sergei10a-rgb/mongolgpt"
export const repositorySupportUrl = `${repositoryUrl}/issues`

/**
 * Application-wide constants and configuration
 */
export const config = {
  // Base URL
  baseUrl: import.meta.env.VITE_MONGOLGPT_PUBLIC_URL?.trim() || repositoryUrl,

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
    twitter: repositorySupportUrl,
    discord: import.meta.env.VITE_MONGOLGPT_COMMUNITY_URL?.trim() || `${repositoryUrl}/discussions`,
  },

  // Static stats (used on landing page)
  stats: {
    contributors: "1",
    commits: "5",
    monthlyUsers: "0",
  },
} as const
