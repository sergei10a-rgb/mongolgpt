# HttpApi замын загвар

Серверээс илгээх үйл явдал (SSE) зэрэг урсгалт HTTP хариутай энгийн API төгсгөлийн цэгүүдийг `HttpApiBuilder.group(...)`-ээр үүсгэ. Боловсруулагчийн давхаргыг үүсгэхдээ тогтвортой үйлчилгээнүүдийг нэг удаа `yield` хийж аваад, төгсгөлийн цэгийн хэрэгжүүлэлтэд closure хэлбэрээр хадгал.

```ts
export const sessionHandlers = HttpApiBuilder.group(InstanceHttpApi, "session", (handlers) =>
  Effect.gen(function* () {
    const session = yield* Session.Service

    return handlers.handle("list", () => session.list())
  }),
)
```

SSE төгсгөлийн цэгийг мөн `HttpApiBuilder.group(...)` дотор үүсгэж, боловсруулагчаас `HttpServerResponse.stream(...)` буцаа. Амжилттай хариуны схемийг `HttpApiSchema.asText({ contentType: "text/event-stream" })`-ээр тэмдэглэснээр OpenAPI баримт бичигт урсгалын агуулгын төрөл зөв тусна.

WebSocket upgrade зам зэрэг боловсруулаагүй хүсэлт эсвэл хариу шаарддаг зарлагдсан төгсгөлийн цэгт `handleRaw(...)`-тай `HttpApiBuilder.group(...)` ашигла. Ингэснээр төгсгөлийн цэгийн middleware, чиглүүлэлтийн контекст болон OpenAPI мета өгөгдөл нэг төрөлжсөн замын модонд хадгалагдана.

```ts
export const ptyConnectHandlers = HttpApiBuilder.group(PtyConnectApi, "pty-connect", (handlers) =>
  Effect.gen(function* () {
    const pty = yield* Pty.Service

    return handlers.handleRaw("connect", (ctx) => connectPty(ctx.request, pty))
  }),
)
```

Боловсруулаагүй `HttpRouter.use(...)`-ийг зөвхөн UI-ийн бүх хүсэлтийг барих нөөц зам зэрэг зарлагдсан API-ийн гаднах замд ашигла.

Хүсэлт боловсруулагч эсвэл боловсруулаагүй замын callback дотор `Effect.provide(SomeLayer)` ашиглахаас зайлсхий. Тогтвортой давхаргыг хүсэлт бүрд дахин үүсгэхгүй; програмын давхаргын зааг дээр нэг удаа `provide` хийж хамрах хүрээг нь тогтоо.

Хамаарал нь зориудаар нэг хүсэлтийн хүрээнийх биш бол `HttpRouter.provideRequest(...)` ашиглахаас зайлсхий. Тогтвортой програмын үйлчилгээнд `HttpRouter.use(...)`-ийг илүүд үз.

Middleware дотор `Effect.provideService(...)`-ийг зөвхөн `WorkspaceRouteContext`, `InstanceRef`, `WorkspaceRef` зэрэг хүсэлтээс үүссэн контекстэд ашигла. Давхарга үүсэх үед `yield` хийж авч болох тогтвортой үйлчилгээг хүсэлтийн effect-ээр далд дамжуулахад үүнийг бүү ашигла.

Нийтийн JSON алдаа нь төгсгөлийн цэг бүр дээр зарласан тодорхой `Schema.ErrorClass` гэрээтэй байх ёстой. Дотоод `HttpApiError.*` классыг зөвхөн хоосон эсвэл тэмдэглэгдсэн бие нь дамжуулалтын хэлбэр болдог үед ашигла. Мессежтэй, SDK-д харагдах алдаанд `ApiNotFoundError` шиг API алдааны схем тодорхойлоод яг тэр зарласан алдаагаар дуусга. Домэйн болон хадгалалтын үйлчилгээг HttpApi төрлөөс ангид байлгаж, хүлээгдэж буй домэйны алдааг боловсруулагчийн зааг дээр хөрвүүл.

Middleware нэмэхдээ төгсгөлийн цэгийн гэрээний middleware-ийг эзэмшигч `HttpApiGroup` дээр зарлаж, хэрэгжүүлэлтийн давхаргыг `server.ts`-ийн угсралтын зааг дээр `provide` хий. Router middleware-ийг зөвхөн боловсруулаагүй нөөц зам эсвэл бүх дамжуулалтад үйлчлэх дүрэмд үлдээ.
