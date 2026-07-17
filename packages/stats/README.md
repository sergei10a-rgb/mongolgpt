# MongolGPT статистик

Статистикийн сайт нь Cloudflare дээр ажиллах тусдаа SolidStart апп юм. Хэрэглээний мэдээллийг үндсэн Cloudflare D1 сангийн `usage` хүснэгтээс шууд, зөвхөн нэгтгэсэн байдлаар уншина. Мэдээллийн захидлын сайн дурын бүртгэлийг мөн D1-ийн `newsletter_subscriber` хүснэгтэд зөвшөөрлийн хувилбар, сонгосон хэлтэй нь хадгална. Тусдаа PlanetScale сан, AWS Athena, ECS sync service эсвэл EmailOctopus ашиглахгүй.

## Бүтэц

- `app`: статистикийн SolidStart интерфэйс.
- `core`: D1 өгөгдлийг нэгтгэн статистикийн дэлгэцэд бэлтгэх уншигч. Мэдээллийн захидлын хуваалцсан логик нь D1 schema-тайгаа хамт `packages/console/core`-т байрлана.

## Команд

- `bun run dev:stats`: repository-ийн үндэснээс локал хөгжүүлэлтийн сервер асаана.
- `bun run --cwd packages/stats/app typecheck`: интерфэйсийн төрлийн шалгалт.
- `bun run --cwd packages/stats/core typecheck`: D1 статистик уншигчийн төрлийн шалгалт.
