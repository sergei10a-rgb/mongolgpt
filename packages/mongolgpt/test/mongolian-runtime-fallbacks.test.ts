import { describe, expect, test } from "bun:test"

const contracts: Record<string, { expected: string[]; forbidden: string[] }> = {
  "index.ts": {
    expected: ["командыг автоматаар гүйцээх бүрхүүлийн скрипт үүсгэх", "Гэнэтийн алдаа"],
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
    expected: [
      "Зургийг тайлж чадсангүй",
      "Зургийн хэмжээг өөрчлөх хэрэгсэл ашиглах боломжгүй байна",
      "Зургийн URL нь base64 data URL байх ёстой",
    ],
    forbidden: ["Image could not be decoded", "Image resizer is unavailable", "Image URL must be a base64 data URL"],
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
    expected: [
      "Зөвшөөрлийн код дутуу байна",
      "Төлөв буруу байна. CSRF халдлага байж болзошгүй.",
      "Нэвтрэлтийг цуцаллаа",
      "Олдсонгүй",
    ],
    forbidden: ["Missing authorization code", "Invalid state - potential CSRF attack", "Login cancelled", "Not found"],
  },
  "plugin/openai/codex.ts": {
    expected: [
      "Зөвшөөрлийн код дутуу байна",
      "Төлөв буруу байна. CSRF халдлага байж болзошгүй.",
      "Төхөөрөмжийн зөвшөөрлийг эхлүүлж чадсангүй",
      "Нэвтрэлтийг цуцаллаа",
      "Олдсонгүй",
    ],
    forbidden: [
      "Missing authorization code",
      "Invalid state - potential CSRF attack",
      "Failed to initiate device authorization",
      "Login cancelled",
      "Not found",
    ],
  },
  "plugin/digitalocean.ts": {
    expected: ["Олдсонгүй"],
    forbidden: ["Not found"],
  },
  "plugin/mongolgpt.ts": {
    expected: ["Олдсонгүй"],
    forbidden: ["Not found"],
  },
  "account/account.ts": {
    expected: ["Олдсонгүй"],
    forbidden: ["Not found"],
  },
  "session/prompt.ts": {
    expected: [
      "Агент олдсонгүй",
      "Боломжтой агентууд",
      "Нөөц олдсонгүй",
      "Команд олдсонгүй",
      "Боломжтой командууд",
      "Үйлчилгээ үзүүлэгчийн агуулгын шүүлтүүр хариуг хориглолоо",
    ],
    forbidden: [
      "Agent not found",
      "Available agents",
      "Resource not found",
      "Command not found",
      "Available commands",
      "The response was blocked by the provider's content filter",
    ],
  },
  "question/index.ts": {
    expected: ["Хэрэглэгч энэ асуултаас татгалзлаа"],
    forbidden: ["The user dismissed this question"],
  },
  "util/repository.ts": {
    expected: ["Репозиторын утга git URL", "Дотоод файлын репозитор дэмжигдэхгүй", "Салбарын нэрд зөвхөн"],
    forbidden: ["Repository must be", "Local file repositories are not supported", "Branch must contain only"],
  },
  "session/compaction.ts": {
    expected: ["Харилцан ярианы түүхийг шахахад хэт том байна", "Сешнийг шахахад хэт том байна"],
    forbidden: ["Conversation history too large to compact", "Session too large to compact"],
  },
  "plugin/azure.ts": {
    expected: ["Azure нөөцийн нэрийг оруулна уу", "API түлхүүр", "жишээ нь my-models"],
    forbidden: ["Enter Azure Resource Name", 'label: "API key"', "e.g. my-models"],
  },
  "plugin/cloudflare.ts": {
    expected: [
      "Cloudflare аккаунтын ID-гаа оруулна уу",
      "Cloudflare AI Gateway-ийн ID-гаа оруулна уу",
      "Gateway-ийн API токен",
    ],
    forbidden: ["Enter your Cloudflare Account ID", "Enter your Cloudflare AI Gateway ID", "Gateway API token"],
  },
  "session/llm/native-runtime.ts": {
    expected: ["API түлхүүр тохируулаагүй байна"],
    forbidden: ["API key is not configured"],
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
