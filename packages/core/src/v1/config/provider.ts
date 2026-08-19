export * as ConfigProviderV1 from "./provider"

import { Schema } from "effect"
import { PositiveInt } from "../../schema"

export const ModelStatus = Schema.Literals(["alpha", "beta", "deprecated", "active"])

export const Model = Schema.Struct({
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  family: Schema.optional(Schema.String),
  release_date: Schema.optional(Schema.String),
  attachment: Schema.optional(Schema.Boolean),
  reasoning: Schema.optional(Schema.Boolean),
  temperature: Schema.optional(Schema.Boolean),
  tool_call: Schema.optional(Schema.Boolean),
  interleaved: Schema.optional(
    Schema.Union([
      Schema.Literal(true),
      Schema.Struct({
        field: Schema.Literals(["reasoning", "reasoning_content", "reasoning_details"]),
      }),
    ]),
  ),
  cost: Schema.optional(
    Schema.Struct({
      input: Schema.Finite,
      output: Schema.Finite,
      cache_read: Schema.optional(Schema.Finite),
      cache_write: Schema.optional(Schema.Finite),
      context_over_200k: Schema.optional(
        Schema.Struct({
          input: Schema.Finite,
          output: Schema.Finite,
          cache_read: Schema.optional(Schema.Finite),
          cache_write: Schema.optional(Schema.Finite),
        }),
      ),
    }),
  ),
  limit: Schema.optional(
    Schema.Struct({
      context: Schema.Finite,
      input: Schema.optional(Schema.Finite),
      output: Schema.Finite,
    }),
  ),
  modalities: Schema.optional(
    Schema.Struct({
      input: Schema.optional(Schema.mutable(Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"])))),
      output: Schema.optional(
        Schema.mutable(Schema.Array(Schema.Literals(["text", "audio", "image", "video", "pdf"]))),
      ),
    }),
  ),
  experimental: Schema.optional(Schema.Boolean),
  status: Schema.optional(ModelStatus),
  provider: Schema.optional(
    Schema.Struct({ npm: Schema.optional(Schema.String), api: Schema.optional(Schema.String) }),
  ),
  options: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  variants: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.StructWithRest(
        Schema.Struct({
          disabled: Schema.optional(Schema.Boolean).annotate({ description: "Энэ загварын хувилбарыг идэвхгүй болгох" }),
        }),
        [Schema.Record(Schema.String, Schema.Any)],
      ),
    ).annotate({ description: "Хувилбар тус бүрийн тохиргоо" }),
  ),
})

export const Info = Schema.Struct({
  api: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  env: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  id: Schema.optional(Schema.String),
  npm: Schema.optional(Schema.String),
  whitelist: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  blacklist: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  options: Schema.optional(
    Schema.StructWithRest(
      Schema.Struct({
        apiKey: Schema.optional(Schema.String),
        baseURL: Schema.optional(Schema.String),
        enterpriseUrl: Schema.optional(Schema.String).annotate({
          description: "Copilot танин баталгаажуулалтад ашиглах GitHub Enterprise URL",
        }),
        setCacheKey: Schema.optional(Schema.Boolean).annotate({
          description: "Энэ үйлчилгээ үзүүлэгчид promptCacheKey-г идэвхжүүлэх (өгөгдмөл: false)",
        }),
        timeout: Schema.optional(
          Schema.Union([PositiveInt, Schema.Literal(false)]).annotate({
            description: "Энэ үйлчилгээ үзүүлэгчид илгээх бүтэн хүсэлтийн хүлээлгийн хугацаа, миллисекундээр. false утга өгвөл хүлээлгийн хугацааг идэвхгүй болгоно.",
          }),
        ).annotate({
          description: "Энэ үйлчилгээ үзүүлэгчид илгээх бүтэн хүсэлтийн хүлээлгийн хугацаа, миллисекундээр. false утга өгвөл хүлээлгийн хугацааг идэвхгүй болгоно.",
        }),
        headerTimeout: Schema.optional(
          Schema.Union([PositiveInt, Schema.Literal(false)]).annotate({
            description:
              "Хариуны толгой хэсгийг хүлээх хугацаа, миллисекундээр. Үйлчилгээ үзүүлэгчийн холболт өгөгдмөл утга тохируулж болно. false утга өгвөл хүлээлгийн хугацааг идэвхгүй болгоно.",
          }),
        ).annotate({
          description:
            "Хариуны толгой хэсгийг хүлээх хугацаа, миллисекундээр. Үйлчилгээ үзүүлэгчийн холболт өгөгдмөл утга тохируулж болно. false утга өгвөл хүлээлгийн хугацааг идэвхгүй болгоно.",
        }),
        chunkTimeout: Schema.optional(PositiveInt).annotate({
          description:
            "Энэ үйлчилгээ үзүүлэгчийн дамжуулж буй SSE хэсгүүдийн хооронд зөвшөөрөх хугацаа, миллисекундээр. Энэ хугацаанд ямар ч хэсэг ирэхгүй бол хүсэлтийг цуцална.",
        }),
      }),
      [Schema.Record(Schema.String, Schema.Any)],
    ),
  ),
  models: Schema.optional(Schema.Record(Schema.String, Model)),
}).annotate({ identifier: "ProviderConfig" })
export type Info = Schema.Schema.Type<typeof Info>
