export type OAuthIdentityResolution = {
  providerAccountID?: string
  emailAccountID?: string
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
