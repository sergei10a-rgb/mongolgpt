import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const webRoot = join(import.meta.dir, "..")
const read = (path: string) => readFileSync(join(webRoot, path), "utf8")

test("Share tool labels are defined in the Mongolian message catalog", () => {
  const catalog = JSON.parse(read("src/content/i18n/mn.json")) as Record<string, string>
  const labels = {
    tool_grep: "Мөр хайх",
    tool_fetch: "Вэб татах",
    tool_read: "Файл унших",
    tool_write: "Файл бичих",
    tool_edit: "Файл засах",
    tool_glob: "Файл хайх",
    tool_task: "Дэд даалгавар",
    tool_shell: "Терминал",
  }

  for (const [name, value] of Object.entries(labels)) {
    expect(catalog[`share.${name}`]).toBe(value)
  }
})

test("Share components consume the injected tool labels", () => {
  const part = read("src/components/share/part.tsx")
  const bash = read("src/components/share/content-bash.tsx")
  const page = read("src/pages/s/[id].astro")

  for (const name of ["grep", "fetch", "read", "write", "edit", "glob", "task"]) {
    expect(part).toContain(`messages.tool_${name}`)
    expect(page).toContain(`tool_${name}: tx("share.tool_${name}")`)
  }
  expect(bash).toContain("messages.tool_shell")
  expect(page).toContain('tool_shell: tx("share.tool_shell")')

  for (const label of ["Grep", "Fetch", "Read", "Write", "Edit", "Glob", "Task"]) {
    expect(part).not.toMatch(new RegExp(`data-slot=\\"name\\">${label}<`))
  }
  expect(bash).not.toContain(">Shell<")
})
