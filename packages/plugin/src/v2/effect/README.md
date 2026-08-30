# MongolGPT V2 Effect залгаасын API

`Effect` залгаасын API нь залгааст процесс доторх дараах хоёр боломжийг олгоно:

- `hook` нь MongolGPT-ийн өргөтгөх цэгт үйлдэл бүртгэнэ.
- `reload` нь төлөв хадгалдаг дэд системийн бүх хувиргалтын `hook`-ийг дахин ажиллуулна.

Нийтийн серверийн клиент нь тусад нь ил гарна. Одоогоор түүнийг зориуд `PluginContext`-ийн бүрэлдэхүүнд оруулаагүй.

## Залгаас тодорхойлох

```ts
import { define } from "@mongolgpt/plugin/v2/effect"
import { Effect } from "effect"

export const Plugin = define({
  id: "example",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.catalog.transform((catalog) => {
      catalog.provider.update("example", (provider) => {
        provider.name = "Example"
      })
    })
  }),
})
```

Залгаасын `setup` нь `hook`-уудыг шууд бүртгэх бөгөөд `hook`-ийн объект буцаахгүй.

Залгааст өгсөн тохиргоог `ctx.options`-оос авна.

Бүртгэлүүд залгаасын хамрах хүрээнд харьяалагдана. Хамрах хүрээ хаагдахад автоматаар цэвэрлэгдэх бөгөөд `dispose` ашиглан түүнээс өмнө устгаж болно.

## Хувиргалтын hook

Хувиргалтын `hook` нь төлөвтэй дэд системд нэмэлт өөрчлөлт оруулна:

```ts
yield *
  ctx.agent.transform((agent) => {
    agent.update("reviewer", (item) => {
      item.description = "Reviews code for regressions"
      item.mode = "subagent"
    })
  })
```

`Transform` бүртгэх эсвэл `dispose` хийхэд MongolGPT тухайн дэд системийг дахин байгуулна. Энэ явц цэвэр төлвөөс эхэлж, идэвхтэй бүх `transform`-ийг бүртгэсэн дарааллаар ажиллуулна.

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

Ажиллах үеийн `hook` нь дэд системийн төлвийг дахин байгуулахын оронд явагдаж буй бодит үйлдэлд дундаас нь оролцоно:

```ts
yield *
  ctx.aisdk.sdk(
    Effect.fn(function* (event) {
      if (event.package !== "@ai-sdk/xai") return
      const mod = yield* Effect.promise(() => import("@ai-sdk/xai"))
      event.sdk = mod.createXai(event.options)
    }),
  )

yield *
  ctx.aisdk.language((event) => {
    if (event.model.providerID !== "xai") return
    event.language = event.sdk.responses(event.model.api.id)
  })
```

`Hook`-ууд нь бүртгэгдсэн дарааллаараа ээлжлэн ажиллана. Дараагийн `hook` нь өмнөх `hook`-ийн хийсэн өөрчлөлтийг харж чадна.

## Дэд системийг дахин ачаалах

`Transform`-ийн ашиглаж буй өгөгдөл өөрчлөгдвөл нөлөөлсөн дэд системийг дахин ачаална:

```ts
let data = yield * loadCatalog()

yield *
  ctx.catalog.transform((catalog) => {
    applyCatalog(data, catalog)
  })

data = yield * loadCatalog()
yield * ctx.catalog.reload()
```

`Reload` нь нэг бүртгэлд биш, дэд системд хамаарна. `ctx.catalog.reload()` нь каталогийн идэвхтэй бүх `transform`-ийг дахин ажиллуулж, шинээр байгуулсан `catalog`-ийг нийтэлнэ.

Ашиглаж болох `reload` үйлдлүүд:

```ts
ctx.agent.reload()
ctx.catalog.reload()
ctx.command.reload()
ctx.integration.reload()
ctx.reference.reload()
ctx.skill.reload()
```
