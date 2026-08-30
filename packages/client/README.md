# @mongolgpt/client

MongolGPT-ийн үндсэн Effect `HttpApi`-аас шууд үүсгэдэг клиентүүдийн дотоод багц.

## Орох цэгүүд

- `@mongolgpt/client`: `fetch` ашигладаг, Effect-гүй Promise клиент.
- `@mongolgpt/client/effect`: орчноос өгсөн `HttpClient` ашигладаг, Effect дээр суурилсан сүлжээний клиент.

Үүсгэсэн API нь серверийн бодит API доторх Session бүлгээс эхэлнэ. Бүтээх үеийн хөрвүүлэгч `@mongolgpt/server/api`-г уншина. Үүсгэсэн Effect ажиллах орчин Protocol-оос байгуулсан, зөвхөн клиентэд хамаарах дүрслэлийг импортолдог бөгөөд үүсгэлтийн ижил байдлын шалгалт дамжуулалтын зөрүү гарахаас сэргийлнэ. Гэрээг өөрчилсний дараа `bun run generate`, репод хадгалсан үр дүн зөрсөн эсэхийг шалгахдаа `bun run check:generated` ажиллуул.

Effect орох цэг нь `Session.ID`, `Location.Ref`, `Prompt` зэрэг нэгдсэн дүрмээр тайлсан утгуудыг ашиглана. Эдгээр өгөгдлийн төрөл хөнгөн `@mongolgpt/schema` багцаас ирдэг бөгөөд дуудагч тал зөвхөн клиентийн API-гаас хамааралтай байлгахын тулд эндээс дахин экспортлогдоно. Protocol нь endpoint үүсгэх болон middleware байрлуулах ажлыг хариуцна. Сервер нь бүтээх үеийн API-д ашиглах бодит middleware түлхүүрүүдийг өгнө.

Promise үндэс нь бүтцийн хэлбэрээ хадгалж, Core эсвэл Effect ажиллах орчноос хамаарахгүй. `/effect` нь зөвхөн Effect, Schema, Protocol-оос хамаардаг тул хөтөчид багцлан ашиглахад аюулгүй. Багцын заагийн шалгалтууд энэ хоёр импортын хамаарлыг албадан мөрдүүлнэ.

Effect ашиглаж буй тал нэгдсэн дүрмээр тайлсан оролтоо дараах байдлаар үүсгэнэ:

```ts
import { AbsolutePath, Location, MongolGPT, Prompt } from "@mongolgpt/client/effect"

const client = yield * MongolGPT.make({ baseUrl: "https://mongolgpt.example" })
yield *
  client.sessions.create({
    location: Location.Ref.make({ directory: AbsolutePath.make("/workspace") }),
  })
yield * client.sessions.prompt({ sessionID, prompt: Prompt.make({ text: "Hello" }) })
```
