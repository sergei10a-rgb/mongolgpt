import { fileURLToPath } from "node:url"

export type RuntimeDeployStage = "dev" | "production"

const runtimeRoot = fileURLToPath(new URL("..", import.meta.url))

export function parseRuntimeDeployStage(value: string | undefined): RuntimeDeployStage {
  if (value === "dev" || value === "production") return value
  throw new Error("Runtime deploy stage нь dev эсвэл production байна.")
}

export function createRuntimeDeployCommand(input: {
  stage: RuntimeDeployStage
  version: string
  args?: string[]
  bunExecutable?: string
}) {
  const version = input.version.trim()
  if (!version) throw new Error("Runtime package version дутуу байна.")

  const config = fileURLToPath(new URL(`../wrangler.${input.stage}.jsonc`, import.meta.url))
  return [
    input.bunExecutable ?? process.execPath,
    "x",
    "wrangler",
    "deploy",
    ...(input.args ?? []),
    `--config=${config}`,
    "--var",
    `MONGOLGPT_RUNTIME_VERSION:${version}`,
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

  const child = Bun.spawn(createRuntimeDeployCommand({ stage, version: packageJSON.version, args }), {
    cwd: runtimeRoot,
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  return child.exited
}

if (import.meta.main) process.exitCode = await runRuntimeDeploy()
