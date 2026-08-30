# MongolGPT хуваалцсан сесс

Энэ багц нь MongolGPT-ийн хуваалцсан coding session-ийг `share.mgpt.mn` дээр зөвхөн унших хэлбэрээр үзүүлэх SolidStart үйлчилгээ юм. Production өгөгдлийг Cloudflare R2-д хадгална.

## Үндсэн хэсгүүд

- `src/routes/share/[shareID].tsx` - хуваалцсан сессийн дэлгэц
- `src/routes/api/[...path].ts` - хуваалцах үйлчилгээний API
- `src/core/share.ts` - сессийн өгөгдлийн дүрэм
- `src/core/storage.ts` - Cloudflare R2 хадгалалтын adapter
- `infra/enterprise.ts` - `share.<domain>` Worker болон R2 bucket-ийн тохиргоо

## Локал ажиллуулах

Репогийн үндсэн хавтсаас dependency-г суулгана:

```bash
bun install --frozen-lockfile
```

Дараа нь энэ багц дотроос:

```bash
bun run dev
```

## Шалгалт

```bash
bun run typecheck
bun run build:cloudflare
```

Локал туршилтаас бусад орчинд санах ойн хадгалалт ашиглахгүй. Production deploy-ийг зөвхөн GitHub Actions workflow болон зөвшөөрөгдсөн Cloudflare credential-ээр хийнэ.
