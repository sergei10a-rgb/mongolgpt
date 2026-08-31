import { describe, expect, test } from "bun:test"

const catalog = (await Bun.file(new URL("../src/content/i18n/mn.json", import.meta.url)).json()) as Record<
  string,
  string
>

describe("Starlight Монгол accessibility орчуулга", () => {
  test("Pagefind болон кодын хэрэгслийн fallback label бүр Монгол байна", () => {
    expect(catalog).toMatchObject({
      "pagefind.clear_search": "Хайлтыг арилгах",
      "pagefind.load_more": "Илүү үр дүн ачаалах",
      "pagefind.search_label": "Энэ сайтаас хайх",
      "pagefind.filters_label": "Шүүлтүүрүүд",
      "pagefind.zero_results": "[SEARCH_TERM] хайлтад үр дүн олдсонгүй",
      "pagefind.many_results": "[SEARCH_TERM] хайлтад [COUNT] үр дүн олдлоо",
      "pagefind.one_result": "[SEARCH_TERM] хайлтад [COUNT] үр дүн олдлоо",
      "pagefind.alt_search":
        "[SEARCH_TERM] хайлтад үр дүн олдсонгүй. Оронд нь [DIFFERENT_TERM] хайлтын үр дүнг харуулж байна",
      "pagefind.search_suggestion":
        "[SEARCH_TERM] хайлтад үр дүн олдсонгүй. Дараах хайлтын аль нэгийг туршина уу:",
      "pagefind.searching": "[SEARCH_TERM] гэж хайж байна...",
      "expressiveCode.copyButtonCopied": "Хуулсан!",
      "expressiveCode.copyButtonTooltip": "Түр санах ойд хуулах",
      "expressiveCode.terminalWindowFallbackTitle": "Терминалын цонх",
    })
  })
})
