export function isAllowedNonProductionEmail(email: string, entries: string | undefined) {
  const allowlist = entries
    ?.split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
  if (!allowlist?.length) return false

  const normalizedEmail = email.trim().toLowerCase()
  return allowlist.some((entry) => {
    if (entry.includes("@")) return normalizedEmail === entry
    return normalizedEmail.endsWith(`@${entry.replace(/^@/, "")}`)
  })
}
