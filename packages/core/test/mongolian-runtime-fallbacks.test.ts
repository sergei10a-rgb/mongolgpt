import { describe, expect, test } from "bun:test"

const files = ["mongolgpt.ts", "openai.ts"] as const

describe("provider OAuth-ийн Монгол fallback мэдээлэл", () => {
  for (const file of files) {
    test(file, async () => {
      const source = await Bun.file(new URL(`../src/plugin/provider/${file}`, import.meta.url)).text()
      expect(source).toContain('end("Олдсонгүй")')
      expect(source).not.toContain('end("Not found")')
    })
  }
})

const runtimeContracts: Record<string, { expected: string[]; forbidden: string[] }> = {
  "question.ts": {
    expected: ["Хэрэглэгч энэ асуултаас татгалзлаа"],
    forbidden: ["The user dismissed this question"],
  },
  "tool/read.ts": {
    expected: ["Зургийг амжилттай уншлаа", "Файлыг уншиж чадсангүй"],
    forbidden: ["Image read successfully", "Unable to read"],
  },
  "tool/todowrite.ts": {
    expected: ["Хийх ажлын жагсаалтыг шинэчилж чадсангүй"],
    forbidden: ["Unable to update todos"],
  },
  "tool/skill.ts": {
    expected: ["Ур чадварыг ачаалж чадсангүй"],
    forbidden: ["Unable to load skill"],
  },
  "tool/apply-patch.ts": {
    expected: ["Нөхөөсийг хэрэглэж чадсангүй", "Өмнө нь хэрэглэсэн"],
    forbidden: ["Unable to apply patch", "Patch partially applied"],
  },
}

describe("core runtime-ийн Монгол мэдээлэл", () => {
  for (const [file, contract] of Object.entries(runtimeContracts)) {
    test(file, async () => {
      const source = await Bun.file(new URL(`../src/${file}`, import.meta.url)).text()
      for (const value of contract.expected) expect(source).toContain(value)
      for (const value of contract.forbidden) expect(source).not.toContain(value)
    })
  }
})
