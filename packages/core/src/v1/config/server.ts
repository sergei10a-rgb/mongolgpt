export * as ConfigServerV1 from "./server"

import { Schema } from "effect"
import { PositiveInt } from "../../schema"

export const Server = Schema.Struct({
  port: Schema.optional(PositiveInt).annotate({
    description: "Серверийн хүсэлт хүлээн авах порт",
  }),
  hostname: Schema.optional(Schema.String).annotate({ description: "Серверийн хүсэлт хүлээн авах хостын нэр" }),
  mdns: Schema.optional(Schema.Boolean).annotate({ description: "mDNS үйлчилгээний илрүүлэлтийг идэвхжүүлэх" }),
  mdnsDomain: Schema.optional(Schema.String).annotate({
    description: "mDNS үйлчилгээнд ашиглах өөрийн домэйн нэр (анхдагч: mongolgpt.local)",
  }),
  cors: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "CORS-д зөвшөөрөх нэмэлт домэйнууд",
  }),
}).annotate({ identifier: "ServerConfig" })
export type Server = Schema.Schema.Type<typeof Server>
