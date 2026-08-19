export * as ConfigMCPV1 from "./mcp"

import { Schema } from "effect"
import { PositiveInt } from "../../schema"

export const Local = Schema.Struct({
  type: Schema.Literal("local").annotate({ description: "MCP сервертэй холбогдох төрөл" }),
  command: Schema.mutable(Schema.Array(Schema.String)).annotate({
    description: "MCP серверийг ажиллуулах команд болон аргументууд",
  }),
  cwd: Schema.optional(Schema.String).annotate({
    description: "MCP серверийн процессын ажиллах хавтас. Харьцангуй замыг ажлын талбарын хавтаснаас тооцно.",
  }),
  environment: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({
    description: "MCP серверийг ажиллуулах үед тохируулах орчны хувьсагчид",
  }),
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Эхлүүлэх үед MCP серверийг идэвхжүүлэх эсвэл идэвхгүй болгох",
  }),
  timeout: Schema.optional(PositiveInt).annotate({
    description: "MCP серверийн хүсэлтийн хүлээлгийн хугацаа, миллисекундээр. Заагаагүй бол 5000 (5 секунд) байна.",
  }),
}).annotate({ identifier: "McpLocalConfig" })
export type Local = Schema.Schema.Type<typeof Local>

export const OAuth = Schema.Struct({
  clientId: Schema.optional(Schema.String).annotate({
    description: "OAuth клиентын ID. Заагаагүй бол динамик клиент бүртгэл (RFC 7591)-ийг оролдоно.",
  }),
  clientSecret: Schema.optional(Schema.String).annotate({
    description: "OAuth клиентийн нууц түлхүүр (зөвшөөрлийн сервер шаардсан тохиолдолд)",
  }),
  scope: Schema.optional(Schema.String).annotate({ description: "Зөвшөөрөл авах үед хүсэх OAuth хамрах хүрээ" }),
  callbackPort: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))).annotate({
    description:
      "OAuth буцах хүсэлтийг хүлээн авах локал серверийн порт (анхдагч: 19876). Зөвхөн портыг өөрчлөх үед redirectUri-ийн товчилсон тохиргоо болно. redirectUri тохируулсан бол үл хэрэгсэнэ.",
  }),
  redirectUri: Schema.optional(Schema.String).annotate({
    description: "OAuth redirect URI (анхдагч: http://127.0.0.1:19876/mcp/oauth/callback).",
  }),
}).annotate({ identifier: "McpOAuthConfig" })
export type OAuth = Schema.Schema.Type<typeof OAuth>

export const Remote = Schema.Struct({
  type: Schema.Literal("remote").annotate({ description: "MCP сервертэй холбогдох төрөл" }),
  url: Schema.String.annotate({ description: "Алсын MCP серверийн URL" }),
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Эхлүүлэх үед MCP серверийг идэвхжүүлэх эсвэл идэвхгүй болгох",
  }),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({
    description: "Хүсэлтийн хамт илгээх HTTP толгой талбарууд",
  }),
  oauth: Schema.optional(Schema.Union([OAuth, Schema.Literal(false)])).annotate({
    description: "MCP серверийн OAuth нэвтрэлтийн тохиргоо. OAuth-г автоматаар танихыг зогсоохын тулд false утга тохируулна.",
  }),
  timeout: Schema.optional(PositiveInt).annotate({
    description: "MCP серверийн хүсэлтийн хүлээлгийн хугацаа, миллисекундээр. Заагаагүй бол 5000 (5 секунд) байна.",
  }),
}).annotate({ identifier: "McpRemoteConfig" })
export type Remote = Schema.Schema.Type<typeof Remote>

export const Info = Schema.Union([Local, Remote]).annotate({ discriminator: "type" })
export type Info = Schema.Schema.Type<typeof Info>
