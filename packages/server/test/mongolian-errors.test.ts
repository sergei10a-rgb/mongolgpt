import { describe, expect, test } from "bun:test"

const contracts: Record<string, string[]> = {
  "middleware/session-location.ts": ["Сессийн ID буруу байна", "Сесс олдсонгүй"],
  "middleware/authorization.ts": ["Нэвтрэлт шаардлагатай"],
  "handlers/session.ts": [
    "Курсор буруу байна",
    "Сесс олдсонгүй",
    "Мессеж олдсонгүй",
    "үйлдэл хараахан боломжгүй байна",
  ],
  "handlers/message.ts": [
    "Курсорыг эрэмбийн тохиргоотой хамт ашиглах боломжгүй",
    "Курсор буруу байна",
    "Сесс олдсонгүй",
  ],
  "handlers/question.ts": ["Асуултын хүсэлт олдсонгүй"],
  "handlers/permission.ts": ["Зөвшөөрлийн хүсэлт олдсонгүй", "Сесс олдсонгүй"],
  "handlers/pty.ts": ["PTY сесс олдсонгүй", "PTY холболтын токены хүсэлт буруу байна", "сесс дууссан"],
  "handlers/provider.ts": ["Үйлчилгээ үзүүлэгч олдсонгүй"],
  "handlers/integration.ts": ["Баталгаажуулалт амжилтгүй боллоо", "Зөвшөөрлийн код шаардлагатай"],
  "handlers/project-copy.ts": [
    "Төслийг хуулах эх үүсвэр олдсонгүй",
    "Төслийн хуулбарын очих зам аль хэдийн байна",
    "Төслийн хуулбарын хавтас ашиглах боломжгүй",
    "Төслийн хуулбарын хавтас буруу байна",
    "Төслийг хуулах арга ашиглах боломжгүй",
  ],
}

const englishFallbacks = [
  "Invalid session ID",
  "Session not found",
  "Authentication required",
  "Invalid cursor",
  "Cursor cannot be combined with order",
  "Prompt message ID conflicts",
  "is not available yet",
  "Message not found",
  "Question request not found",
  "Permission request not found",
  "PTY session not found",
  "Invalid PTY connect token request",
  '"session not found"',
  '"session exited"',
  "Provider not found",
  "Authentication failed",
  "Authorization code is required",
  "Project copy source not found",
  "Project copy destination already exists",
  "Project copy directory unavailable",
  "Invalid project copy directory",
  "Project copy strategy unavailable",
]

describe("server API-ийн Монгол алдааны мэдээлэл", () => {
  for (const [file, expected] of Object.entries(contracts)) {
    test(file, async () => {
      const source = await Bun.file(new URL(`../src/${file}`, import.meta.url)).text()

      for (const value of expected) expect(source).toContain(value)
      for (const value of englishFallbacks) expect(source).not.toContain(value)
    })
  }
})
