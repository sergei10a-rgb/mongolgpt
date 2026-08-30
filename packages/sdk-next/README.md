# @mongolgpt/sdk-next

Нэг процесс дотор ажилладаг аппуудад зориулсан, Effect-д натив, хамрах хүрээтэй MongolGPT хост. Хэрэглэгчид нь шилжиж дууссаны дараа энэ түр шилжилтийн багц одоогийн үүсгэсэн `@mongolgpt/sdk`-ийг орлоно.

SDK нь серверийн угсарсан HTTP чиглүүлэгчийг санах ойд ажиллуулна. Сүлжээ сонсох цэг нээхгүй, сүлжээний оролт гаралт хийхгүй боловч сүлжээний клиенттэй ижил чиглүүлэлт, middleware, боловсруулагч, codec болон алдааг хадгална.

```ts
import { MongolGPT } from "@mongolgpt/sdk-next"

const mongolgpt = yield * MongolGPT.create()
const session = yield * mongolgpt.sessions.get({ sessionID })
```

Мөн `Tool`-ийг экспортолж, өмнөх `@mongolgpt/core/public` facade-ийг орлох зөвхөн дотоод орчинд ашиглах `tools.register(...)` боломжийг гаргана. Бүртгэхдээ хостын `Location`-уудын дунд хуваалцдаг Core-ийн хост түвшний `ApplicationTools` үйлчилгээг ашиглана. Харин `Location` бүр давхар тохируулга, хайлт болон үр дүн тогтоох өөрийн `ToolRegistry`-г хадгална. Эзэмшигч Effect Scope-ийг хаахад чиглүүлэгчийн нөөц, байршлын үйлчилгээ, fiber болон хамрах хүрээтэй хэрэгслийн бүртгэлүүд чөлөөлөгдөнө.

`sessions.events({ sessionID, after })` нь заавал бус нэгтгэсэн дарааллын дугаараас хойших хадгалагдах event-үүдийг дахин тоглуулаад, шинээр баталгаажсан event-үүдийг үргэлжлүүлэн гаргана. `sessions.interrupt(...)` нь энэ хостын эзэмшдэг ажиллуулалтыг тасална. `sessions.message(...)` нь дүрслэн гаргасан нэг Session зурвасыг уншина.

Ижил байгуулагчийг үйлчилгээний Layer хэлбэрээр бас ашиглаж болно:

```ts
const program = Effect.gen(function* () {
  const mongolgpt = yield* MongolGPT.Service
  return yield* mongolgpt.sessions.get({ sessionID })
})

yield * program.pipe(Effect.provide(MongolGPT.layer))
```

`MongolGPT.layer` нь `MongolGPT.create()`-ийг хамаарал шахан оруулахад тохируулан ашиглах бөгөөд өөр тусдаа хостын хэрэгжүүлэлт тодорхойлохгүй.
