# MongolGPT аппын интерфэйс

Энэ багц нь MongolGPT-ийн Web болон Desktop клиентэд ашиглагддаг SolidJS интерфэйсийн эх код юм. Chat, coding session, project, history, provider, account, plan болон usage дэлгэцийг нэг кодын сангаас ажиллуулна.

## Аккаунт ба Free Auto

- Анхны нээлтээр MongolGPT аккаунтаар нэвтрэхийг заавал шаардана.
- Нэвтэрсэн хэрэглэгч `MongolGPT Free Auto`-г subscription эсвэл төлбөрийн хэрэгсэлгүйгээр ашиглаж болно.
- OpenRouter, NVIDIA NIM, өөрийн API түлхүүр болон local model нэмэх нь сонголттой.
- Web клиент local project-той ажиллахдаа Desktop/local bridge ашиглана.

## Локал хөгжүүлэлт

Репогийн үндсэн хавтаст dependency суулгана:

```bash
bun install
```

Backend-ийг нэг terminal-д ажиллуулна:

```bash
cd packages/mongolgpt
bun run --conditions=browser ./src/index.ts serve --port 4096
```

Интерфэйсийг өөр terminal-д ажиллуулна:

```bash
cd packages/app
bun dev -- --port 4444
```

Дараа нь `http://localhost:4444` хаягийг нээнэ. Интерфэйс нь `http://localhost:4096` дахь local backend-тэй холбогдоно.

## Шалгалт

```bash
bun run typecheck
bun run test:unit
bun run test:browser
bunx playwright install chromium
bun run test:e2e:local
```

Тодорхой E2E урсгал ажиллуулах жишээ:

```bash
bun run test:e2e:local -- --grep "Free Auto"
```

Playwright-ийн local тохиргоонд дараах орчны хувьсагчийг ашиглаж болно:

- `PLAYWRIGHT_SERVER_HOST`, `PLAYWRIGHT_SERVER_PORT` - backend хаяг; анхдагч нь `localhost:4096`
- `PLAYWRIGHT_PORT` - Vite порт; анхдагч нь `3000`
- `PLAYWRIGHT_BASE_URL` - шалгах Web аппын бүтэн хаяг

## Hosted build ба байршуулалт

Hosted artifact-ийг build хийж, API/runtime boundary зөв эсэхийг хамтад нь шалгана:

```bash
bun run build:hosted
```

`dist/` нь зөвхөн клиент artifact. MongolGPT backend-ийн оронд static host дээр дангаар нь байршуулж болохгүй. Dev болон production байршуулалтыг репогийн Cloudflare workflow, deployment preflight болон deploy smoke шалгалтаар гүйцэтгэнэ.
