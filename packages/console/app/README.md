# MongolGPT Console

Энэ багц нь MongolGPT-ийн нийтийн сайт, нэгдсэн нэвтрэлт, аккаунт ба ажлын талбарын удирдлага, төлбөр, model gateway болон хэрэглэгчийн дэмжлэгийн web console юм. SolidStart дээр ажиллаж, Cloudflare Workers-д байрлана.

## Үндсэн хэсгүүд

- `src/routes/index.tsx` - `mgpt.mn` нүүр хуудас
- `src/routes/auth/` - Web, Desktop, CLI-д зориулсан нэгдсэн OAuth урсгал
- `src/routes/workspace/` - аккаунт, provider, API түлхүүр, хэрэглээ, plan ба төлбөр
- `src/routes/gateway/` - OpenAI/Anthropic-compatible model gateway
- `src/routes/support/` - хэрэглэгчийн тусламж ба хүсэлт
- `src/routes/legal/` - үйлчилгээний нөхцөл ба нууцлалын бодлого
- `src/i18n/mn.ts` - үндсэн Монгол орчуулга

## Локал ажиллуулах

Репогийн үндсэн хавтсаас dependency-г суулгана:

```bash
bun install --frozen-lockfile
```

Хөгжүүлэлтийн серверийг ажиллуулах:

```bash
bun run dev:console
```

Эсвэл энэ багц дотроос:

```bash
bun run dev
```

## Шалгалт

```bash
bun run typecheck
bun test
bun run build
```

Production build-ийг жинхэнэ Chromium дээр нээж, Монгол хэл, зураг, hydration, console error болон desktop/mobile overflow-ийг шалгах:

```bash
bun --cwd ../../app test:e2e:console
```

## Deploy

Dev болон production deploy-ийг репогийн GitHub Actions workflow-оор хийнэ. Production deploy, бодит төлбөр болон package publish-ийг зөвшөөрөлгүйгээр локал командаар ажиллуулахгүй.

Нууц түлхүүрийг source, log, screenshot эсвэл commit-д оруулахгүй. Cloudflare болон provider credential-ийг зөвхөн GitHub Environment secret болон Cloudflare secret binding-д хадгална.
