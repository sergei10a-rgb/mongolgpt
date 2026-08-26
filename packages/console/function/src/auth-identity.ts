export type OAuthIdentityResolution = {
  providerAccountID?: string
  emailAccountID?: string
}

export type OAuthIdentityMatch = {
  provider: string
  accountID: string
  timeDeleted: unknown
}

export class OAuthIdentityConflictError extends Error {
  constructor() {
    super("MongolGPT нэвтрэх эрхийн мэдээлэл зөрчилтэй байна.")
    this.name = "OAuthIdentityConflictError"
  }
}

export function resolveOAuthAccountIdentity({
  providerAccountID,
  emailAccountID,
}: OAuthIdentityResolution): string | undefined {
  if (providerAccountID && emailAccountID && providerAccountID !== emailAccountID) {
    throw new OAuthIdentityConflictError()
  }

  return providerAccountID ?? emailAccountID
}

export function resolveActiveOAuthAccountIdentity(
  matches: readonly OAuthIdentityMatch[],
  provider: string,
): string | undefined {
  const active = matches.filter((match) => match.timeDeleted === null)
  return resolveOAuthAccountIdentity({
    providerAccountID: active.find((match) => match.provider === provider)?.accountID,
    emailAccountID: active.find((match) => match.provider === "email")?.accountID,
  })
}
