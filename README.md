# MongolGPT

MongolGPT бол Монгол хэрэглэгчдэд эхнээсээ ойлгомжтой байх зорилготой хиймэл оюунтай код бичих агентын платформ юм.

## Юу багтсан бэ

- Терминал дээр ажиллах хиймэл оюунтай код бичих агент
- Windows ширээний апп
- Provider, skill, plugin, connector, MCP холболтыг MongolGPT дээр тааруулах суурь
- Монгол UI болон Монгол баримт бичгийн эхний хувилбар
- CLI болон desktop дээр MongolGPT account-аар нэвтрэх холболтын суурь
- Бусад agent ecosystem-ийн skill/plugin/MCP-ийг MongolGPT дээр тааруулах adapter layer-ийн эхлэл

## Монгол баримт бичиг

MongolGPT-ийн docs:

[https://mongolgpt.duckdns.org/docs/](https://mongolgpt.duckdns.org/docs/)

Docs-ийн үндсэн хуудас болон Монгол locale нь Монгол хэл дээр байна.

## Desktop хувилбар татах

Windows суулгагч:

[mongolgpt-desktop-win-x64.exe](https://github.com/sergei10a-rgb/mongolgpt/releases/download/v0.1.0/mongolgpt-desktop-win-x64.exe)

Хувилбарын хуудас:

[https://github.com/sergei10a-rgb/mongolgpt/releases](https://github.com/sergei10a-rgb/mongolgpt/releases)

## Local дээр ажиллуулах

```bash
bun install
bun run dev
```

Desktop хөгжүүлэлтийн горим:

```bash
bun run dev:desktop
```

Windows desktop суулгагч build хийх:

```powershell
$env:MONGOLGPT_CHANNEL="prod"
bun --cwd packages/desktop run package:win
```

Build дууссаны дараа installer энд гарна:

```text
packages/desktop/dist/
```

## NPM package төлөв

`mongolgpt` npm package-ийн publish script repo дотор бэлтгэгдсэн. Package registry дээр нийтлэхийн тулд npm account/token шаардлагатай.

Package нийтлэгдсэний дараах command:

```bash
npm install -g mongolgpt
```

Нийтлэгдэхээс өмнө GitHub Release эсвэл source build ашиглана.

## Эх кодын сан

MongolGPT-ийн албан ёсны эх код:

[https://github.com/sergei10a-rgb/mongolgpt](https://github.com/sergei10a-rgb/mongolgpt)

## Тайлбар

Энэ repo нь MongolGPT-ийн өөрийн standalone history, brand, desktop build, Монгол UX рүү цэвэрлэгдсэн хувилбар.

## Лиценз

MIT
