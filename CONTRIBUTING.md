# MongolGPT-д хувь нэмэр оруулах

MongolGPT-д хувь нэмэр оруулахад аль болох ойлгомжтой, хялбар байлгахыг зорьж байна. Дараах төрлийн өөрчлөлтүүдийг ихэвчлэн хүлээн авна.

- Алдаа засвар
- LSP болон formatter нэмэлт
- LLM performance сайжруулалт
- Шинэ provider-ийн дэмжлэг
- Тухайн орчинд гардаг жижиг асуудлын засвар
- Стандарт behavior дутсан хэсгийг нөхөх
- Баримт бичиг, орчуулгын сайжруулалт

UI эсвэл core product feature нэмэх бол хэрэгжүүлэхээсээ өмнө design review хийнэ.

PR явуулах эсэхдээ эргэлзэж байвал maintainer-аас асууж болно. Эсвэл дараах label-тэй issue-үүдээс эхэлж болно.

- [`help wanted`](https://github.com/sergei10a-rgb/mongolgpt/issues?q=is%3Aissue%20state%3Aopen%20label%3Ahelp-wanted)
- [`good first issue`](https://github.com/sergei10a-rgb/mongolgpt/issues?q=is%3Aissue%20state%3Aopen%20label%3A%22good%20first%20issue%22)
- [`bug`](https://github.com/sergei10a-rgb/mongolgpt/issues?q=is%3Aissue%20state%3Aopen%20label%3Abug)
- [`perf`](https://github.com/sergei10a-rgb/mongolgpt/issues?q=is%3Aopen%20is%3Aissue%20label%3A%22perf%22)

> [!NOTE]
> Эдгээр guardrail-ийг үл тоосон PR хаагдах магадлалтай.

Issue дээр ажиллах бол comment үлдээнэ үү. Maintainer тухайн ажлыг аль хэдийн хийж эхлээгүй бол танд assign хийж болно.

## Шинэ provider нэмэх

Шинэ provider нэмэхэд аль болох бага code change шаардагдах ёстой. Хэрэв шинэ provider-ийн support нэмэх гэж байгаа бол эхлээд дараах repo-д PR явуулна.

[https://github.com/sergei10a-rgb/models.dev](https://github.com/sergei10a-rgb/models.dev)

## MongolGPT хөгжүүлэх

Шаардлага:

- Bun 1.3+

Repo root дээр dependency суулгаад dev server эхлүүлэх:

```bash
bun install
bun dev
```

### Өөр directory дээр ажиллуулах

Default үед `bun dev` нь MongolGPT-ийг `packages/mongolgpt` directory дээр ажиллуулна. Өөр directory эсвэл repository дээр ажиллуулах бол:

```bash
bun dev <directory>
```

MongolGPT repo-ийн root дээр ажиллуулах бол:

```bash
bun dev .
```

### Standalone executable build хийх

```bash
./packages/mongolgpt/script/build.ts --single
```

Дараа нь ингэж ажиллуулна:

```bash
./packages/mongolgpt/dist/mongolgpt-<platform>/bin/mongolgpt
```

`<platform>` хэсгийг өөрийн platform-аар солино. Жишээ нь `darwin-arm64`, `linux-x64`.

Гол package-ууд:

- `packages/mongolgpt`: MongolGPT core logic болон server
- `packages/mongolgpt/src/cli/cmd/tui/`: SolidJS болон opentui дээр бичигдсэн TUI
- `packages/app`: Shared web UI component-ууд
- `packages/desktop`: Electron дээр build хийсэн desktop app
- `packages/plugin`: `@mongolgpt/plugin` эх код

### `bun dev` ба `mongolgpt`

Development үед `bun dev` нь build хийгдсэн `mongolgpt` command-той ижил CLI interface ажиллуулна.

```bash
# Development
bun dev --help
bun dev serve
bun dev web
bun dev <directory>

# Production
mongolgpt --help
mongolgpt serve
mongolgpt web
mongolgpt <directory>
```

### API server ажиллуулах

```bash
bun dev serve
```

Default port нь `4096`. Өөр port ашиглах бол:

```bash
bun dev serve --port 8080
```

### Web app ажиллуулах

UI өөрчлөлт туршихдаа:

1. MongolGPT server-ийг эхлүүлнэ.
2. Web app-ийг ажиллуулна.

```bash
bun run --cwd packages/app dev
```
