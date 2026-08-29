import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const root = resolve(import.meta.dir, "../../..")
const read = (path: string) => readFileSync(resolve(root, path), "utf8")

describe("public GitHub surface", () => {
  test("publishes Mongolian issue and pull request templates", () => {
    const bug = read(".github/ISSUE_TEMPLATE/bug-report.yml")
    const feature = read(".github/ISSUE_TEMPLATE/feature-request.yml")
    const pullRequest = read(".github/pull_request_template.md")
    const bugForm = Bun.YAML.parse(bug) as {
      name?: string
      body?: Array<{ attributes?: { label?: string } }>
    }
    const featureForm = Bun.YAML.parse(feature) as { name?: string; title?: string }

    expect(bugForm.name).toBe("Алдаа мэдээлэх")
    expect(bugForm.body?.[0]?.attributes?.label).toBe("Асуудлын тайлбар")
    expect(featureForm.name).toBe("Шинэ боломж санал болгох")
    expect(featureForm.title).toBe("[САНАЛ]:")
    expect(pullRequest).toContain("### Энэ PR юу хийж байгаа вэ?")
    expect(pullRequest).toContain("### Код ажиллаж байгааг хэрхэн шалгасан бэ?")

    for (const source of [bug, feature, pullRequest]) {
      expect(source).not.toMatch(/Bug report|Feature Request|What happened\?|What does this PR do\?|Checklist/)
    }
  })

  test("keeps PR enforcement aligned with the Mongolian template and main branch", () => {
    const workflow = read(".github/workflows/pr-standards.yml")

    for (const heading of [
      "### Энэ PR-ийн issue",
      "### Өөрчлөлтийн төрөл",
      "### Энэ PR юу хийж байгаа вэ",
      "### Код ажиллаж байгааг хэрхэн шалгасан бэ",
      "### Шалгах жагсаалт",
    ]) {
      expect(workflow).toContain(heading)
    }
    expect(workflow).toContain("ref: 'main'")
    expect(workflow).toContain("../blob/main/CONTRIBUTING.md")
    expect(workflow).not.toContain("ref: 'dev'")
    expect(workflow).not.toContain("../blob/dev/")
    expect(() => Bun.YAML.parse(workflow)).not.toThrow()
  })

  test("keeps public automation comments Mongolian and on the canonical branch", () => {
    const compliance = read(".github/workflows/compliance-close.yml")
    const duplicates = read(".github/workflows/duplicate-issues.yml")

    expect(compliance).toContain("Энэ pull request-ийг")
    expect(compliance).toContain("Энэ issue-г")
    expect(duplicates).toContain("Write the whole public comment in Mongolian")
    expect(duplicates).toContain("Энэ issue нь [хувь нэмэр оруулах заавар]")
    expect(duplicates).toContain("This project has two issue templates")
    expect(duplicates).not.toContain("This project has three issue templates")
    expect(duplicates).not.toContain("#4997")
    expect(duplicates.match(/steps\.config\.outputs\.enabled == 'true'/g)).toHaveLength(8)
    expect(duplicates.match(/steps\.config\.outputs\.enabled != 'true'/g)).toHaveLength(2)
    expect(duplicates).toContain("MONGOLGPT_API_KEY тохируулаагүй тул")
    for (const source of [compliance, duplicates]) {
      expect(source).not.toContain("../blob/dev/")
      expect(() => Bun.YAML.parse(source)).not.toThrow()
    }
  })

  test("keeps public package descriptions and links Mongolian-first", () => {
    const desktop = JSON.parse(read("packages/desktop/package.json"))
    const recorder = JSON.parse(read("packages/http-recorder/package.json"))

    expect(desktop.description).toBe("MongolGPT хиймэл оюунт кодын агентын ширээний програм")
    expect(recorder.description).toBe(
      "Effect HTTP клиентийн урсгалыг тогтвортой бичлэгээр хадгалж, дахин тоглуулах хэрэгсэл",
    )
    expect(recorder.homepage).toBe("https://github.com/sergei10a-rgb/mongolgpt/tree/main/packages/http-recorder")
  })
})
