import { appendFile } from "node:fs/promises"
import { deploymentServiceUrlOutputs, serializeGitHubOutputs } from "@mongolgpt/script/deployment-service-urls"

const stage = process.argv[2] ?? ""
const outputs = deploymentServiceUrlOutputs(process.env.MONGOLGPT_DOMAIN ?? "", stage)
const githubOutput = process.env.GITHUB_OUTPUT

if (githubOutput) {
  await appendFile(githubOutput, `${serializeGitHubOutputs(outputs)}\n`, "utf8")
} else {
  console.log(JSON.stringify(outputs, null, 2))
}
