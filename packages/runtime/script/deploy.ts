import { resolveHostedServiceUrls } from "@mongolgpt/account-contract/service-urls"
import { fileURLToPath } from "node:url"

export type RuntimeDeployStage = "dev" | "production"

const runtimeRoot = fileURLToPath(new URL("..", import.meta.url))

export function parseRuntimeDeployStage(value: string | undefined): RuntimeDeployStage {
  if (value === "dev" || value === "production") return value
  throw new Error("Runtime deploy stage нь dev эсвэл production байна.")
}

export function createRuntimeDeployCommand(input: {
  stage: RuntimeDeployStage
  rootDomain: string
  version: string
  args?: string[]
  bunExecutable?: string
}) {
  const version = input.version.trim()
  if (!version) throw new Error("Runtime package version дутуу байна.")
  const urls = resolveHostedServiceUrls(input.rootDomain, input.stage)

  const config = fileURLToPath(new URL(`../wrangler.${input.stage}.jsonc`, import.meta.url))
  return [
    input.bunExecutable ?? process.execPath,
    "x",
    "wrangler",
    "deploy",
    ...(input.args ?? []),
    `--config=${config}`,
    "--domain",
    new URL(urls.runtime).hostname,
    "--var",
    `MONGOLGPT_RUNTIME_VERSION:${version}`,
    "--var",
    `MONGOLGPT_APP_ORIGIN:${urls.app}`,
    "--var",
    `MONGOLGPT_CONSOLE_URL:${urls.console}`,
    "--var",
    `STAGE:${input.stage}`,
  ]
}

export async function runRuntimeDeploy(argv = process.argv.slice(2)) {
  const [rawStage, ...args] = argv
  const stage = parseRuntimeDeployStage(rawStage)
  const packageJSON: unknown = await Bun.file(new URL("../package.json", import.meta.url)).json()
  if (
    typeof packageJSON !== "object" ||
    packageJSON === null ||
    !("version" in packageJSON) ||
    typeof packageJSON.version !== "string"
  ) {
    throw new Error("Runtime package version дутуу байна.")
  }

  const child = Bun.spawn(
    createRuntimeDeployCommand({
      stage,
      rootDomain: process.env.MONGOLGPT_DOMAIN ?? "",
      version: packageJSON.version,
      args,
    }),
    {
      cwd: runtimeRoot,
      env: process.env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  )
  return child.exited
}

if (import.meta.main) process.exitCode = await runRuntimeDeploy()
