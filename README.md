# MongolGPT

MongolGPT бол Монгол хэрэглэгчдэд эхнээсээ ойлгомжтой байх зорилготой AI кодын агент платформ юм. Терминал, ширээний апп, IDE өргөтгөл, үйлчилгээ үзүүлэгч, ур чадвар, нэмэлт, холбогч, MCP холболтыг нэг дор ажиллуулах суурьтай.

## Юу багтсан бэ

- Монгол хэл дээр анхдагчаар нээгдэх Windows ширээний апп
- Терминал дээр ажиллах `mongolgpt` AI кодын агент
- MongolGPT бүртгэл болон үйлчилгээ үзүүлэгчийн нэвтрэлтийн холболтын суурь
- Claude, Codex, Goose, Hermes зэрэг агентын экосистемийн ур чадвар, нэмэлт, MCP форматыг таньж MongolGPT-д тааруулах импортлогч
- Тохиргооны `Интеграц` хэсэгт команд, зам, URL, тохиргоо оруулж төлөвлөх, хэрэгжүүлэх урсгал
- Монгол баримт бичиг, README, таталт болон хувилбарын тайлбарын суурь

## Ширээний апп татах

Одоогоор нийтлэгдсэн ширээний хувилбар нь Windows x64 суулгац юм.

[mongolgpt-desktop-win-x64.exe татах](https://github.com/sergei10a-rgb/mongolgpt/releases/latest/download/mongolgpt-desktop-win-x64.exe)

Бүх хувилбар:

[github.com/sergei10a-rgb/mongolgpt/releases](https://github.com/sergei10a-rgb/mongolgpt/releases)

Одоогийн суулгац тоон гарын үсэггүй тул Windows SmartScreen анхааруулга харуулж магадгүй.

## Монгол баримт бичиг

MongolGPT-ийн Монгол баримт бичиг:

[Баримт бичгийн эхийг GitHub дээрээс нээх](https://github.com/sergei10a-rgb/mongolgpt/tree/main/packages/web/src/content/docs)

Баримт бичгийн үндсэн эх нь `packages/web/src/content/docs/` дотор байна. Нийтлэх домэйн баталгаажаагүй байгаа тул эзэмшдэггүй туршилтын домэйн руу холбоос заагаагүй.

## Локал орчинд ажиллуулах

```bash
bun install
bun run dev
```

Ширээний аппын хөгжүүлэлтийн горим:

```bash
bun run dev:desktop
```

Баримт бичгийн хөгжүүлэлтийн горим:

```bash
bun run dev:docs
```

Windows ширээний суулгац бэлтгэх:

```powershell
$env:MONGOLGPT_CHANNEL="prod"
bun --cwd packages/desktop run package:win
```

Бэлтгэл дууссаны дараа суулгац энд гарна:

```text
packages/desktop/dist/
```

## Интеграц оруулах

MongolGPT нь MCP сервер, ур чадвар, нэмэлт, холбогч төрлийн эх сурвалжийг төлөвлөх, хэрэгжүүлэх хоёр алхмаар тохиргоонд нэмнэ.

```bash
mongolgpt compat import plan "npx -y @modelcontextprotocol/server-filesystem C:\\Users\\me"
mongolgpt compat import apply "npx -y @modelcontextprotocol/server-filesystem C:\\Users\\me"
```

Ширээний аппын `Тохиргоо -> Интеграц` хэсэгт команд, локал зам, URL эсвэл тохиргоо оруулахад хэрэглэгчээр хөрвүүлэгч бичүүлэхгүйгээр автоматаар тааруулна.

## NPM багцын төлөв

`mongolgpt@0.1.1` болон платформын бүх гүйцэтгэх багц npm бүртгэлд нийтлэгдсэн. Терминал хувилбарыг npm-ээр шууд суулгаж туршиж болно:

```bash
npm install -g mongolgpt
mongolgpt --version
```

Эх кодоос бэлтгэх эсвэл хөгжүүлэлтийн горим ашиглах бол:

```bash
git clone https://github.com/sergei10a-rgb/mongolgpt
cd mongolgpt
bun install
bun run dev
```

## Эх кодын сан

[github.com/sergei10a-rgb/mongolgpt](https://github.com/sergei10a-rgb/mongolgpt)

Энэ эх кодын сан нь MongolGPT-ийн бие даасан эх код, брэнд, ширээний хувилбар, Монгол хэрэглэгчийн туршлага болон тохируулагч давхаргын үндсэн сан юм.

## Лиценз

MIT. Гуравдагч талын эх кодын мэдэгдлийг [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)-оос үзнэ үү.
