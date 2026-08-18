import { describe, expect, test } from "bun:test"

const mongolgpt = new URL("../../mongolgpt/src/", import.meta.url)
const tui = new URL("../../tui/src/", import.meta.url)

describe("Монгол хэрэглэгчийн интерфэйсийн гэрээ", () => {
  test("CLI-ийн шинэчлэх, устгах болон MCP урсгалыг Монгол хэлээр үзүүлнэ", async () => {
    const upgrade = await Bun.file(new URL("cli/cmd/upgrade.ts", mongolgpt)).text()
    const uninstall = await Bun.file(new URL("cli/cmd/uninstall.ts", mongolgpt)).text()
    const mcp = await Bun.file(new URL("cli/cmd/mcp.ts", mongolgpt)).text()

    expect(upgrade).toContain('prompts.intro("MongolGPT шинэчлэх")')
    expect(upgrade).toContain('spinner.start("Шинэчилж байна...")')
    expect(upgrade).not.toContain('prompts.intro("Upgrade")')
    expect(upgrade).not.toContain("package manager-аар")

    expect(uninstall).toContain('message: "MongolGPT-ийг устгахдаа итгэлтэй байна уу?"')
    expect(uninstall).toContain('label: "Кэш"')
    expect(uninstall).toContain('keepOption: "--keep-data"')
    expect(uninstall).toContain('keepOption: "--keep-config"')
    expect(uninstall).not.toContain('label: "Cache"')
    expect(uninstall).not.toContain("--keep-${dir.label.toLowerCase()}")

    expect(mcp).toContain('placeholder: "жишээ нь mongolgpt x @modelcontextprotocol/server-filesystem"')
    expect(mcp).toContain('placeholder: "жишээ нь https://example.com/mcp"')
    expect(mcp).not.toContain('placeholder: "e.g.,')
  })

  test("CLI footer болон TUI-ийн командын тайлбар Монгол байна", async () => {
    const footer = await Bun.file(new URL("cli/cmd/run/footer.view.tsx", mongolgpt)).text()
    const dialog = await Bun.file(new URL("ui/dialog-select.tsx", tui)).text()
    const whichKey = await Bun.file(new URL("feature-plugins/system/which-key.tsx", tui)).text()
    const workspace = await Bun.file(new URL("component/dialog-workspace-create.tsx", tui)).text()
    const prompt = await Bun.file(new URL("component/prompt/index.tsx", tui)).text()
    const mcpSidebar = await Bun.file(new URL("feature-plugins/sidebar/mcp.tsx", tui)).text()

    expect(footer).toContain('label: "арын горим"')
    expect(footer).toContain("label: `${queue()} дараалалд`")
    expect(footer).toContain('label: "дэд агент"')
    expect(footer).toContain('label: "энгийн горим"')
    expect(footer).toContain('label: "команд"')
    expect(footer).toContain('category: "Хүсэлт"')
    expect(footer).toContain('category: "Загвар"')
    expect(footer).not.toContain('category: "Model"')

    expect(dialog).toContain('category: "Цонх"')
    expect(dialog).not.toContain('category: "Dialog"')
    expect(whichKey).toContain('desc: "Товчны туслахыг асаах/унтраах"')
    expect(workspace).toContain('title: "Ажлын орчны холбогчдыг ачаалж чадсангүй"')
    expect(prompt).toContain("терминалын горимоос гарах")
    expect(mcpSidebar).toContain("Клиентийн ID шаардлагатай")
  })
})
