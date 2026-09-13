import { appendFile, mkdir, mkdtemp } from "node:fs/promises"
import { dirname, join } from "node:path"
import {
  verifyConsoleAuthPatch,
  consoleBaselineCommit,
  consoleFixCommit,
} from "../packages/script/src/console-auth-release"

async function git(...args: string[]) {
  const result = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" })
  const output = await new Response(result.stdout).text()
  await new Response(result.stderr).text()
  if ((await result.exited) !== 0) throw new Error("Pinned Console source preparation failed")
  return output
}

if (process.env.GITHUB_ACTIONS !== "true" || !process.env.RUNNER_TEMP || !process.env.GITHUB_ENV)
  throw new Error("Console auth release preparation requires a disposable GitHub Actions checkout")
if (process.env.GITHUB_REPOSITORY !== "sergei10a-rgb/mongolgpt" || process.env.GITHUB_REF !== "refs/heads/main")
  throw new Error("Unexpected Console release repository or branch")
if ((await git("status", "--porcelain", "--untracked-files=no")).trim())
  throw new Error("Refusing to replace a modified checkout")
await git("merge-base", "--is-ancestor", consoleFixCommit, "HEAD")
verifyConsoleAuthPatch(await git("diff", "--name-status", `${consoleFixCommit}^`, consoleFixCommit))
if (
  (
    await git(
      "diff",
      "--name-only",
      consoleBaselineCommit,
      `${consoleFixCommit}^`,
      "--",
      "package.json",
      "bun.lock",
      "infra",
      "sst.config.ts",
    )
  ).trim()
)
  throw new Error("Pinned infrastructure or dependencies do not match")

const control = await mkdtemp(join(process.env.RUNNER_TEMP, "console-auth-control-"))
for (const path of ["script/verify-console-ui-deployment.ts", "packages/script/src/console-ui-deployment-guard.ts"]) {
  await mkdir(dirname(join(control, path)), { recursive: true })
  await Bun.write(join(control, path), Bun.file(path))
}
const patch = await git("diff", "--binary", `${consoleFixCommit}^`, consoleFixCommit)
const patchFile = join(control, "auth-links.patch")
await Bun.write(patchFile, patch)
await git("switch", "--detach", consoleBaselineCommit)
await git("apply", "--index", patchFile)
verifyConsoleAuthPatch(await git("diff", "--cached", "--name-status"))
if ((await git("diff", "--cached", "--binary")) !== patch)
  throw new Error("Pinned auth patch changed during application")
await git(
  "-c",
  "user.name=MongolGPT release",
  "-c",
  "user.email=actions@users.noreply.github.com",
  "commit",
  "-m",
  "fix(console): apply verified auth links to deployed baseline",
)
const source = (await git("rev-parse", "HEAD")).trim()
await appendFile(process.env.GITHUB_ENV, `AUTH_UI_CONTROL=${control}\nMONGOLGPT_RELEASE_SHA=${source}\n`)
console.log(JSON.stringify({ baseline: consoleBaselineCommit, fix: consoleFixCommit, release: source, files: 6 }))
