import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const root = resolve(import.meta.dir, "../../..")
const read = (path: string) => readFileSync(resolve(root, path), "utf8")

describe("MongolGPT GitHub Action release", () => {
  test("publishes only immutable namespaced tags", () => {
    const release = read("github/script/release")
    const publish = read("github/script/publish")
    const releaseWorkflow = read(".github/workflows/release-github-action.yml")
    const publishWorkflow = read(".github/workflows/publish-github-action.yml")

    expect(release).toContain('tag="mongolgpt-github-v${version}"')
    expect(release).toContain('git push origin "refs/tags/${tag}"')
    expect(release).not.toContain("git push --tags")
    expect(release).not.toContain("refs/tags/latest")
    expect(release).not.toContain("--force")
    expect(publish).toContain("^mongolgpt-github-v[0-9]+\\.[0-9]+\\.[0-9]+$")
    expect(publish).not.toContain("refs/tags/latest")
    expect(releaseWorkflow).toContain("workflow_dispatch:")
    expect(releaseWorkflow).toContain("PUBLISH MONGOLGPT GITHUB ACTION $ACTION_VERSION WITH CLI $CLI_VERSION")
    expect(releaseWorkflow).toContain('gh release view "mongolgpt-v${CLI_VERSION}"')
    expect(releaseWorkflow).toContain('./github/script/release "$ACTION_VERSION"')
    expect(publishWorkflow).toContain('"mongolgpt-github-v*.*.*"')
    expect(publishWorkflow).not.toContain('"github-v*.*.*"')
  })

  test("keeps the action and generated workflow on the MongolGPT contract", () => {
    const action = read("github/action.yml")
    const handler = read("packages/mongolgpt/src/cli/cmd/github.handler.ts")
    const workflow = read(".github/workflows/mongolgpt.yml")

    expect(action).toContain("анхдагч нь /mongolgpt")
    expect(action).toContain('default: "0.1.2"')
    expect(action).toContain('VERSION="${{ inputs.cli_version }}" bash "$GITHUB_ACTION_PATH/../install"')
    expect(action).not.toContain("/releases/latest")
    expect(action).not.toContain("raw.githubusercontent.com/sergei10a-rgb/mongolgpt/main/install")
    expect(action).not.toContain("/mongolgpt,/oc")
    expect(handler).toContain("await configureGit(appToken, agentIdentity)")
    expect(handler).toContain("await restoreGitConfig()")
    expect(handler).not.toContain('process.env["MENTIONS"] || "/mongolgpt,/oc"')
    expect(handler).not.toContain("/oc")
    expect(workflow).toContain("sergei10a-rgb/mongolgpt/github@mongolgpt-github-v1.0.0")
    expect(workflow).not.toContain("/oc")
  })

  test("does not document integrations that do not exist", () => {
    const githubDocs = read("packages/web/src/content/docs/github.mdx")
    const gitlabDocs = read("packages/web/src/content/docs/gitlab.mdx")
    const providerDocs = read("packages/web/src/content/docs/providers.mdx")
    const actionReadme = read("github/README.md")
    const sources = [githubDocs, gitlabDocs, providerDocs, actionReadme]

    for (const source of sources) {
      expect(source).not.toContain("github.com/apps/mongolgpt-agent")
      expect(source).not.toContain("mongolgpt/github@latest")
      expect(source).not.toContain("gitlab-mongolgpt")
      expect(source).not.toContain("docs.ollama.com/integrations/mongolgpt")
    }
    expect(githubDocs).toContain("mongolgpt/github@mongolgpt-github-v1.0.0")
    expect(actionReadme).toContain("mongolgpt/github@mongolgpt-github-v1.0.0")
  })
})
