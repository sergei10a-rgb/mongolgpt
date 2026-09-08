import { chmod, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import upstream from "../vendor/sandbox-control/upstream.json"

const root = fileURLToPath(new URL("../", import.meta.url))
const patch = join(root, "vendor/sandbox-control/control-auth.patch")

export async function compileSandbox(source: string, output: string) {
  const shared = join(source, "packages/shared/src")
  const result = await Bun.build({
    entrypoints: [join(source, "packages/sandbox-container/src/main.ts")],
    target: "bun",
    minify: true,
    compile: {
      target: "bun-linux-x64",
      outfile: output,
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadTsconfig: false,
      autoloadPackageJson: false,
    },
    plugins: [
      {
        name: "pinned-sdk-shared-source",
        setup(build) {
          build.onResolve({ filter: /^@repo\/shared(?:\/.*)?$/ }, ({ path }) => {
            const files: Record<string, string> = {
              "@repo/shared": "index.ts",
              "@repo/shared/backup": "backup.ts",
              "@repo/shared/internal": "internal.ts",
              "@repo/shared/errors": "errors/index.ts",
            }
            const file = files[path]
            if (!file) throw new Error("Unsupported pinned SDK shared entrypoint")
            return { path: join(shared, file) }
          })
        },
      },
    ],
  })
  if (!result.success) throw new AggregateError(result.logs, "Sandbox build failed")
  await chmod(output, 0o555)
}

export async function buildSandbox() {
  if (process.platform !== "linux" || process.arch !== "x64") throw new Error("Sandbox image build requires Linux x64")
  const packageJSON = await Bun.file(join(root, "../../package.json")).json()
  if (`bun@${Bun.version}` !== packageJSON.packageManager)
    throw new Error("Sandbox build requires the pinned Bun runtime")
  const directory = await mkdtemp(join(tmpdir(), "mongolgpt-sdk-build-"))
  try {
    const source = join(directory, "source")
    await command(["git", "clone", "--depth", "1", "--branch", upstream.tag, upstream.repository, source])
    const revision = await command(["git", "rev-parse", "HEAD"], source, true)
    if (revision.trim() !== upstream.revision) throw new Error("Pinned Sandbox source revision mismatch")
    await command(["git", "apply", "--check", patch], source)
    await command(["git", "apply", patch], source)
    await command(
      [
        "npm",
        "ci",
        "--ignore-scripts",
        "--workspace=@repo/sandbox-container",
        "--workspace=@repo/shared",
        "--include-workspace-root=false",
        "--omit=dev",
        "--no-audit",
        "--no-fund",
        "--loglevel=error",
      ],
      source,
    )
    await command(["git", "diff", "--exit-code", "--", "package-lock.json"], source)
    const binary = join(directory, "sandbox")
    await compileSandbox(source, binary)
    const output = join(root, "container/sandbox")
    await mkdir(dirname(output), { recursive: true })
    await chmod(output, 0o755).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
    })
    await copyFile(binary, output)
    await chmod(output, 0o555)
    const receipt = {
      revision: upstream.revision,
      version: upstream.version,
      bun: Bun.version,
      patchSha256: new Bun.CryptoHasher("sha256").update(await Bun.file(patch).arrayBuffer()).digest("hex"),
      binarySha256: new Bun.CryptoHasher("sha256").update(await Bun.file(output).arrayBuffer()).digest("hex"),
    }
    await Bun.write(join(root, "container/sandbox-build.json"), JSON.stringify(receipt, null, 2) + "\n")
    console.log("Built authenticated Sandbox", receipt)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export async function verifySandboxBuild(directory = join(root, "container")) {
  const receipt: unknown = await Bun.file(join(directory, "sandbox-build.json")).json()
  const packageJSON = await Bun.file(join(root, "../../package.json")).json()
  const hash = async (file: string) =>
    new Bun.CryptoHasher("sha256").update(await Bun.file(file).arrayBuffer()).digest("hex")
  if (
    !receipt ||
    typeof receipt !== "object" ||
    !("revision" in receipt) ||
    receipt.revision !== upstream.revision ||
    !("version" in receipt) ||
    receipt.version !== upstream.version ||
    !("bun" in receipt) ||
    `bun@${receipt.bun}` !== packageJSON.packageManager ||
    !("patchSha256" in receipt) ||
    receipt.patchSha256 !== (await hash(patch)) ||
    !("binarySha256" in receipt) ||
    receipt.binarySha256 !== (await hash(join(directory, "sandbox")))
  )
    throw new Error("Authenticated Sandbox build is missing, stale or modified; rebuild before deployment")
}

async function command(args: string[], cwd?: string, capture = false) {
  const child = Bun.spawn(args, { cwd, stdin: "ignore", stdout: capture ? "pipe" : "inherit", stderr: "inherit" })
  const output = capture ? await new Response(child.stdout).text() : ""
  if ((await child.exited) !== 0) throw new Error(`Sandbox build command failed: ${args[0]}`)
  return output
}

if (import.meta.main) await buildSandbox()
