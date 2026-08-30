# MongolGPT V2 Promise залгаасын API

`Promise` залгаасын API нь `@mongolgpt/plugin/v2/effect`-ийн `async/await` хувилбар юм. Энэ нь залгааст процесс доторх ижил хоёр боломжийг олгоно:

- `hook` нь MongolGPT-ийн өргөтгөх цэгт үйлдэл бүртгэнэ.
- `reload` нь төлөв хадгалдаг дэд системийн бүх хувиргалтын `hook`-ийг дахин ажиллуулна.

`Effect API`-аас ялгарах цорын ганц зүйл нь `async` зааг юм. `hook`-ийн буцаан дуудагдах функц, `hook` бүртгэл, `reload`, мөн `Registration.dispose` нь `Effect`-ийн оронд `Promise` ашиглана.

## Залгаас тодорхойлох

```ts
import { define } from "@mongolgpt/plugin/v2/promise"

export const Plugin = define({
  id: "example",
  setup: async (ctx) => {
    await ctx.catalog.transform((catalog) => {
      catalog.provider.update("example", (provider) => {
        provider.name = "Example"
      })
    })
  },
})
```

Залгаасын `setup` нь `hook`-уудыг шууд бүртгэх бөгөөд `hook`-ийн объект буцаахгүй.

Залгааст өгсөн тохиргоог `ctx.options`-оос авна.

Бүртгэлийг `dispose` ашиглаад хугацаанаас нь өмнө устгаж болно:

```ts
const registration = await ctx.catalog.transform(applyCatalog)
await registration.dispose()
```

## Хувиргалтын hook

Хувиргалтын `hook` нь төлөвтэй дэд системд нэмэлт өөрчлөлт оруулна. Ноорог засварлагч синхрон ажиллана. Өөр ажил хүлээх шаардлагатай бол буцаан дуудагдах функц нь `async` байж болно:

```ts
await ctx.agent.transform((agent) => {
  agent.update("reviewer", (item) => {
    item.description = "Reviews code for regressions"
    item.mode = "subagent"
  })
})
```

Боломжтой хувиргалтын `hook`-ууд дэд систем тус бүрийн нэрийн мужид байрлана:

```ts
ctx.agent.transform
ctx.catalog.transform
ctx.command.transform
ctx.integration.transform
ctx.reference.transform
ctx.skill.transform
```

## Ажиллах үеийн hook

Ажиллах үеийн `hook` нь явагдаж буй бодит үйлдэлд дундаас нь оролцоно:

```ts
await ctx.aisdk.sdk(async (event) => {
  if (event.package !== "@ai-sdk/xai") return
  const mod = await import("@ai-sdk/xai")
  event.sdk = mod.createXai(event.options)
})

await ctx.aisdk.language((event) => {
  if (event.model.providerID !== "xai") return
  event.language = event.sdk.responses(event.model.api.id)
})
```

## Дэд системийг дахин ачаалах

`Transform`-ийн ашиглаж буй өгөгдөл өөрчлөгдвөл нөлөөлсөн дэд системийг дахин ачаална:

```ts
let data = await loadCatalog()

await ctx.catalog.transform((catalog) => {
  applyCatalog(data, catalog)
})

data = await loadCatalog()
await ctx.catalog.reload()
```

Ашиглаж болох `reload` үйлдлүүд:

```ts
ctx.agent.reload()
ctx.catalog.reload()
ctx.command.reload()
ctx.integration.reload()
ctx.reference.reload()
ctx.skill.reload()
```
