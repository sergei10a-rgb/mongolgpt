import { describe, expect, test } from "bun:test"

const contracts: Record<string, { expected: string[]; forbidden: string[] }> = {
  "index.ts": {
    expected: ["команд автоматаар гүйцээх shell скрипт үүсгэх", "Гэнэтийн алдаа"],
    forbidden: ["generate shell completion script", 'UI.error("Unexpected error"'],
  },
  "provider/transform.ts": {
    expected: ["Дууслаа."],
    forbidden: ['text: "Done."'],
  },
  "skill/index.ts": {
    expected: ["Одоогоор ашиглах боломжтой ур чадвар алга."],
    forbidden: ["No skills are currently available."],
  },
  "patch/index.ts": {
    expected: ["Ямар ч файл өөрчлөгдсөнгүй."],
    forbidden: ["No files were modified."],
  },
  "image/image.ts": {
    expected: ["Зургийг тайлж чадсангүй"],
    forbidden: ["Image could not be decoded"],
  },
  "cli/cmd/run/footer.prompt.tsx": {
    expected: ["Засварлагчийг нээж чадсангүй"],
    forbidden: ["failed to open editor"],
  },
  "account/repo.ts": {
    expected: ["Өгөгдлийн сантай ажиллахад алдаа гарлаа"],
    forbidden: ["Database operation failed"],
  },
  "share/share-next.ts": {
    expected: ["Хуваалцахад ашиглах идэвхтэй бүртгэлийн токен алга"],
    forbidden: ["No active account token available for sharing"],
  },
  "plugin/xai.ts": {
    expected: ["Зөвшөөрлийн код дутуу байна", "Төлөв буруу байна. CSRF халдлага байж болзошгүй."],
    forbidden: ["Missing authorization code", "Invalid state - potential CSRF attack"],
  },
  "plugin/openai/codex.ts": {
    expected: [
      "Зөвшөөрлийн код дутуу байна",
      "Төлөв буруу байна. CSRF халдлага байж болзошгүй.",
      "Төхөөрөмжийн зөвшөөрлийг эхлүүлж чадсангүй",
    ],
    forbidden: [
      "Missing authorization code",
      "Invalid state - potential CSRF attack",
      "Failed to initiate device authorization",
    ],
  },
  "session/prompt.ts": {
    expected: ["Агент олдсонгүй", "Боломжтой агентууд", "Нөөц олдсонгүй", "Команд олдсонгүй", "Боломжтой командууд"],
    forbidden: ["Agent not found", "Available agents", "Resource not found", "Command not found", "Available commands"],
  },
}

describe("runtime-ийн Монгол fallback мэдээлэл", () => {
  for (const [file, contract] of Object.entries(contracts)) {
    test(file, async () => {
      const source = await Bun.file(new URL(`../src/${file}`, import.meta.url)).text()

      for (const value of contract.expected) expect(source).toContain(value)
      for (const value of contract.forbidden) expect(source).not.toContain(value)
    })
  }
})
