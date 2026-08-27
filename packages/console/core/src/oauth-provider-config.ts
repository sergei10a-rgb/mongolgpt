export type OAuthProviderConfigurationInput = {
  stage: string
  githubClientID?: string
  githubClientSecret?: string
  googleClientID?: string
}

export type OAuthProviderConfiguration = {
  github: boolean
  google: boolean
  issues: string[]
}

export function inspectOAuthProviderConfiguration(
  input: OAuthProviderConfigurationInput,
): OAuthProviderConfiguration {
  const githubClientID = input.githubClientID?.trim() ?? ""
  const githubClientSecret = input.githubClientSecret?.trim() ?? ""
  const googleClientID = input.googleClientID?.trim() ?? ""
  const github = Boolean(githubClientID && githubClientSecret)
  const google = Boolean(googleClientID)
  const issues: string[] = []

  if (Boolean(githubClientID) !== Boolean(githubClientSecret)) {
    issues.push("GitHub OAuth-ийн GITHUB_CLIENT_ID_CONSOLE болон GITHUB_CLIENT_SECRET_CONSOLE утгыг хамт тохируулна.")
  }

  if (input.stage === "production") {
    if (!github) issues.push("Production орчинд GitHub OAuth provider бүрэн тохирсон байна.")
    if (!google) issues.push("Production орчинд Google OAuth provider бүрэн тохирсон байна.")
  } else if (!github && !google) {
    issues.push(
      "Dev OAuth-д GITHUB_CLIENT_ID_CONSOLE + GITHUB_CLIENT_SECRET_CONSOLE эсвэл GOOGLE_CLIENT_ID-ийн дор хаяж нэг provider тохируулна.",
    )
  }

  return { github, google, issues }
}
