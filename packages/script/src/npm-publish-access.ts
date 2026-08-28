const registry = "https://registry.npmjs.org"

export const npmPublishCliPackages = [
  "mongolgpt",
  "mongolgpt-linux-arm64",
  "mongolgpt-linux-x64",
  "mongolgpt-linux-x64-baseline",
  "mongolgpt-linux-arm64-musl",
  "mongolgpt-linux-x64-musl",
  "mongolgpt-linux-x64-baseline-musl",
  "mongolgpt-darwin-arm64",
  "mongolgpt-darwin-x64",
  "mongolgpt-darwin-x64-baseline",
  "mongolgpt-windows-arm64",
  "mongolgpt-windows-x64",
  "mongolgpt-windows-x64-baseline",
] as const

export const npmPublishPlatformPackages = ["@mongolgpt/sdk", "@mongolgpt/plugin", "@mongolgpt/ui"] as const

type CommandResult = {
  status: number
  stdout: string
  stderr: string
}

type Run = (args: readonly string[]) => Promise<CommandResult>

export async function verifyNpmPublishAccess(input: { token: string | undefined; run: Run }) {
  if (!input.token?.trim()) throw new Error("NPM_TOKEN тохируулаагүй байна")

  const owner = npmUsername((await command(input.run, ["whoami", `--registry=${registry}`], "npm account")).stdout)
  for (const name of npmPublishCliPackages) {
    const result = await command(
      input.run,
      ["view", name, "maintainers", "--json", `--registry=${registry}`],
      `${name} ownership`,
    )
    if (!maintainers(result.stdout).includes(owner)) {
      throw new Error(`${owner} нь ${name} package-ийн maintainer биш байна`)
    }
  }

  const organization = await command(
    input.run,
    ["org", "ls", "mongolgpt", "--json", `--registry=${registry}`],
    "@mongolgpt organization membership",
  )
  const role = organizationRole(organization.stdout, owner)
  if (!role) throw new Error(`${owner} нь @mongolgpt organization-д publish эрхгүй байна`)

  const access = await command(
    input.run,
    ["access", "list", "packages", "@mongolgpt", "--json", `--registry=${registry}`],
    "@mongolgpt package access",
  )
  jsonRecord(access.stdout, "@mongolgpt package access")

  return {
    owner,
    role,
    cliPackages: npmPublishCliPackages.length,
    platformPackages: npmPublishPlatformPackages.length,
  }
}

async function command(run: Run, args: readonly string[], label: string) {
  const result = await run(args)
  if (result.status === 0) return result
  throw new Error(`${label} шалгалт амжилтгүй боллоо (npm exit ${result.status})`)
}

function npmUsername(value: string) {
  const username = value.trim()
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(username)) throw new Error("npm account-ийн нэр буруу байна")
  return username
}

function maintainers(value: string) {
  const parsed = json(value, "npm maintainer")
  const values = Array.isArray(parsed) ? parsed : [parsed]
  const names = values.flatMap((item) => {
    if (typeof item === "string") return [item.trim().split(/\s+/, 1)[0] ?? ""]
    if (record(item) && typeof item.name === "string") return [item.name.trim()]
    return []
  })
  if (names.length === 0 || names.some((name) => !name)) throw new Error("npm maintainer-ийн хариу буруу байна")
  return names
}

function organizationRole(value: string, owner: string) {
  const members = jsonRecord(value, "npm organization")
  const role = members[owner]
  if (role === "owner" || role === "admin" || role === "developer") return role
  return undefined
}

function jsonRecord(value: string, label: string) {
  const parsed = json(value, label)
  if (!record(parsed)) throw new Error(`${label}-ийн хариу буруу байна`)
  return parsed
}

function json(value: string, label: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    throw new Error(`${label}-ийн JSON хариу буруу байна`)
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
