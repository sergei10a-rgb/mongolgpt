# MongolGPT

MongolGPT бол Монгол хэрэглэгчдэд эхнээсээ ойлгомжтой байх зорилготой AI coding agent платформ юм. Терминал, desktop app, IDE extension, provider, skill, plugin, connector, MCP холболтыг нэг дор ажиллуулах суурьтай.

## Юу багтсан бэ

- Монгол хэл дээр анхдагчаар нээгдэх Windows desktop app
- Терминал дээр ажиллах `mongolgpt` AI coding agent
- MongolGPT account болон provider login холболтын суурь
- Claude, Codex, Goose, Hermes зэрэг agent ecosystem-ийн skill/plugin/MCP форматыг таньж MongolGPT-д тааруулах compatibility importer
- Settings доторх `Интеграц` tab-аас command, path, URL, config оруулж plan/apply хийх workflow
- Монгол docs, README, download/release тайлбарын суурь

## Desktop татах

Одоогоор нийтлэгдсэн desktop build нь Windows x64 installer.

[mongolgpt-desktop-win-x64.exe татах](https://github.com/sergei10a-rgb/mongolgpt/releases/latest/download/mongolgpt-desktop-win-x64.exe)

Бүх release:

[github.com/sergei10a-rgb/mongolgpt/releases](https://github.com/sergei10a-rgb/mongolgpt/releases)

Одоогийн build code signing хийгдээгүй тул Windows SmartScreen анхааруулга харуулж магадгүй.

## Монгол баримт бичиг

MongolGPT docs:

[https://mongolgpt.duckdns.org/docs/](https://mongolgpt.duckdns.org/docs/)

Active docs source нь `packages/web/src/content/docs/` доторх үндсэн Монгол баримт бичиг. `/docs/mn/` хуучин холбоосын нийцтэй байдлаар хадгалагдана.

## Local дээр ажиллуулах

```bash
bun install
bun run dev
```

Desktop development mode:

```bash
bun run dev:desktop
```

Docs development mode:

```bash
bun run dev:docs
```

Windows desktop installer build хийх:

```powershell
$env:MONGOLGPT_CHANNEL="prod"
bun --cwd packages/desktop run package:win
```

Build дууссаны дараа installer энд гарна:

```text
packages/desktop/dist/
```

## Интеграц импортлох

MongolGPT нь MCP server, skill, plugin, connector төрлийн эх сурвалжийг plan/apply хоёр алхмаар тохиргоонд нэмнэ.

```bash
mongolgpt compat import plan "npx -y @modelcontextprotocol/server-filesystem C:\\Users\\me"
mongolgpt compat import apply "npx -y @modelcontextprotocol/server-filesystem C:\\Users\\me"
```

Desktop дээр `Тохиргоо -> Интеграц` хэсгээс command, локал зам, URL эсвэл config оруулаад хэрэглэгчээр wrapper бичүүлэхгүйгээр тааруулах workflow ажиллана.

## NPM package төлөв

`mongolgpt` npm package-ийн release pipeline бэлэн. Зарим binary package npm registry дээр гарсан, үлдсэн package-уудыг registry rate limit сулрах үед үргэлжлүүлэн нийтэлнэ.

Нийтлэгдэхээс өмнө GitHub Release, source build, эсвэл install script ашиглана:

```bash
git clone https://github.com/sergei10a-rgb/mongolgpt
cd mongolgpt
bun install
bun run dev
```

## Эх кодын сан

[github.com/sergei10a-rgb/mongolgpt](https://github.com/sergei10a-rgb/mongolgpt)

Энэ repository нь MongolGPT-ийн standalone source, brand, desktop build, Монгол UX, adapter layer-ийн үндсэн source юм.

## Лиценз

MIT
