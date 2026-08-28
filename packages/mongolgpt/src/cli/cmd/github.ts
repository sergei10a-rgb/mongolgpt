import { Effect } from "effect"
import { cmd } from "./cmd"
import { effectCmd } from "../effect-cmd"

export {
  DEFAULT_GITHUB_MENTIONS,
  MONGOLGPT_GITHUB_ACTION_REF,
  extractResponseText,
  formatPromptTooLargeError,
  githubAgentIdentity,
  githubMentions,
  parseGitHubRemote,
} from "./github.shared"

export const GithubInstallCommand = effectCmd({
  command: "install",
  describe: "GitHub агент суулгах",
  handler: () =>
    Effect.gen(function* () {
      const { githubInstall } = yield* Effect.promise(() => import("./github.handler"))
      return yield* githubInstall()
    }),
})

export const GithubRunCommand = effectCmd({
  command: "run",
  describe: "GitHub агент ажиллуулах",
  builder: (yargs) =>
    yargs
      .option("event", {
        type: "string",
        describe: "агент ажиллуулах GitHub-ийн туршилтын үйл явдал",
      })
      .option("token", {
        type: "string",
        describe: "GitHub-ийн хувийн хандалтын токен (github_pat_********)",
      }),
  handler: (args) =>
    Effect.gen(function* () {
      const { githubRun } = yield* Effect.promise(() => import("./github.handler"))
      return yield* githubRun(args)
    }),
})

export const GithubCommand = cmd({
  command: "github",
  describe: "GitHub агент удирдах",
  builder: (yargs) => yargs.command(GithubInstallCommand).command(GithubRunCommand).demandCommand(),
  async handler() {},
})
