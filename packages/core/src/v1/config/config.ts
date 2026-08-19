export * as ConfigV1 from "./config"

import { Schema } from "effect"
import { NonNegativeInt, PositiveInt, type DeepMutable } from "../../schema"
import { ConfigExperimental } from "../../config/experimental"
import { ConfigReference } from "../../config/reference"
import { documentationRepositoryUrl } from "../../product"
import { ConfigAgentV1 } from "./agent"
import { ConfigAttachmentV1 } from "./attachment"
import { ConfigCommandV1 } from "./command"
import { ConfigFormatterV1 } from "./formatter"
import { ConfigLayoutV1 } from "./layout"
import { ConfigLSPV1 } from "./lsp"
import { ConfigMCPV1 } from "./mcp"
import { ConfigPermissionV1 } from "./permission"
import { ConfigPluginV1 } from "./plugin"
import { ConfigProviderV1 } from "./provider"
import { ConfigServerV1 } from "./server"
import { ConfigSkillsV1 } from "./skills"

export type Layout = ConfigLayoutV1.Layout

export const WellKnown = Schema.Struct({
  config: Schema.optional(Schema.Json),
  remote_config: Schema.optional(Schema.Json),
})

const LogLevelRef = Schema.Literals(["DEBUG", "INFO", "WARN", "ERROR"]).annotate({
  identifier: "LogLevel",
  description: "Логийн түвшин",
})

export const Info = Schema.Struct({
  $schema: Schema.optional(Schema.String).annotate({
    description: "Тохиргоог шалгахад ашиглах JSON schema-ийн лавлагаа",
  }),
  shell: Schema.optional(Schema.String).annotate({ description: "Терминал болон bash хэрэгсэлд ашиглах өгөгдмөл командын бүрхүүл" }),
  logLevel: Schema.optional(LogLevelRef).annotate({ description: "Логийн түвшин" }),
  server: Schema.optional(ConfigServerV1.Server).annotate({
    description: "mongolgpt serve болон web командын серверийн тохиргоо",
  }),
  command: Schema.optional(Schema.Record(Schema.String, ConfigCommandV1.Info)).annotate({
    description: `Командын тохиргоо. Дэлгэрэнгүй: ${documentationRepositoryUrl}/commands.mdx`,
  }),
  skills: Schema.optional(ConfigSkillsV1.Info).annotate({ description: "Ур чадварын нэмэлт хавтасны замууд" }),
  references: Schema.optional(ConfigReference.Info).annotate({
    description: "Нэрлэсэн git эсвэл локал хавтасны лавлагаанууд",
  }),
  reference: Schema.optional(ConfigReference.Info).annotate({
    description: "@deprecated Оронд нь 'references' талбарыг ашиглана уу. Нэрлэсэн git эсвэл локал хавтасны лавлагаанууд",
  }),
  watcher: Schema.optional(Schema.Struct({ ignore: Schema.optional(Schema.mutable(Schema.Array(Schema.String))) })),
  snapshot: Schema.optional(Schema.Boolean).annotate({
    description:
      "Snapshot хөтлөлтийг идэвхжүүлэх эсвэл идэвхгүй болгоно. false үед файлын системийн snapshot хадгалагдахгүй бөгөөд буцаах үйлдэл файлд хийсэн өөрчлөлтийг буцаахгүй. Анхдагч утга нь true.",
  }),
  plugin: Schema.optional(Schema.mutable(Schema.Array(ConfigPluginV1.Spec))),
  share: Schema.optional(Schema.Literals(["manual", "auto", "disabled"])).annotate({
    description:
      "Хуваалцах үйлдлийг удирдана: 'manual' нь командаар гараар хуваалцахыг, 'auto' нь автоматаар хуваалцахыг зөвшөөрнө, 'disabled' нь бүх хуваалцах үйлдлийг идэвхгүй болгоно",
  }),
  autoshare: Schema.optional(Schema.Boolean).annotate({
    description: "@deprecated Оронд нь 'share' талбарыг ашиглана уу. Шинээр үүссэн сессүүдийг автоматаар хуваалцана",
  }),
  autoupdate: Schema.optional(Schema.Union([Schema.Boolean, Schema.Literal("notify")])).annotate({
    description:
      "Хамгийн сүүлийн хувилбар руу автоматаар шинэчилнэ. true нь автоматаар шинэчлэх, false нь идэвхгүй болгох, 'notify' нь шинэчлэлтийн мэдэгдэл харуулах утгатай",
  }),
  disabled_providers: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Автоматаар ачаалагддаг үйлчилгээ үзүүлэгчдийг идэвхгүй болгоно",
  }),
  enabled_providers: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Тохируулсан үед зөвхөн эдгээр үйлчилгээ үзүүлэгч идэвхжинэ. Бусад бүх үйлчилгээ үзүүлэгчийг үл тооно",
  }),
  model: Schema.optional(Schema.String).annotate({
    description: "Ашиглах загварыг provider/model хэлбэрээр заана. Жишээ нь anthropic/claude-2",
  }),
  small_model: Schema.optional(Schema.String).annotate({
    description: "Гарчиг үүсгэх зэрэг ажлуудад ашиглах жижиг загварыг provider/model хэлбэрээр заана",
  }),
  default_agent: Schema.optional(Schema.String).annotate({
    description:
      "Агент заагаагүй үед ашиглах анхдагч агент. Үндсэн агент байх ёстой. Тохируулаагүй эсвэл заасан агент буруу бол 'build' агент руу шилжинэ.",
  }),
  username: Schema.optional(Schema.String).annotate({
    description: "Харилцан ярианд системийн хэрэглэгчийн нэрийн оронд харуулах өөрийн хэрэглэгчийн нэр",
  }),
  mode: Schema.optional(
    Schema.StructWithRest(
      Schema.Struct({ build: Schema.optional(ConfigAgentV1.Info), plan: Schema.optional(ConfigAgentV1.Info) }),
      [Schema.Record(Schema.String, ConfigAgentV1.Info)],
    ),
  ).annotate({ description: "@deprecated Оронд нь `agent` талбарыг ашиглана уу." }),
  agent: Schema.optional(
    Schema.StructWithRest(
      Schema.Struct({
        plan: Schema.optional(ConfigAgentV1.Info),
        build: Schema.optional(ConfigAgentV1.Info),
        general: Schema.optional(ConfigAgentV1.Info),
        explore: Schema.optional(ConfigAgentV1.Info),
        title: Schema.optional(ConfigAgentV1.Info),
        summary: Schema.optional(ConfigAgentV1.Info),
        compaction: Schema.optional(ConfigAgentV1.Info),
      }),
      [Schema.Record(Schema.String, ConfigAgentV1.Info)],
    ),
  ).annotate({ description: `Агентын тохиргоо. Дэлгэрэнгүй: ${documentationRepositoryUrl}/agents.mdx` }),
  provider: Schema.optional(Schema.Record(Schema.String, ConfigProviderV1.Info)).annotate({
    description: "Өөрийн үйлчилгээ үзүүлэгчийн тохиргоо болон загвар тус бүрийн нэмэлт тохиргоо",
  }),
  mcp: Schema.optional(
    Schema.Record(Schema.String, Schema.Union([ConfigMCPV1.Info, Schema.Struct({ enabled: Schema.Boolean })])),
  ).annotate({ description: "MCP (Model Context Protocol) серверийн тохиргоонууд" }),
  formatter: Schema.optional(ConfigFormatterV1.Info).annotate({
    description:
      "Форматлагчдыг идэвхжүүлэх эсвэл тохируулна. Орхих буюу false бол идэвхгүй, true бол суурилагдсан форматлагчдыг идэвхжүүлнэ, объект бол нэмэлт тохиргоотойгоор идэвхжүүлнэ.",
  }),
  lsp: Schema.optional(ConfigLSPV1.Info).annotate({
    description:
      "LSP серверүүдийг идэвхжүүлэх эсвэл тохируулна. Орхих буюу false бол идэвхгүй, true бол суурилагдсан серверүүдийг идэвхжүүлнэ, объект бол нэмэлт тохиргоотойгоор идэвхжүүлнэ.",
  }),
  instructions: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Нэмэх зааврын файлууд эсвэл файлын хэвүүд",
  }),
  layout: Schema.optional(ConfigLayoutV1.Layout).annotate({ description: "@deprecated Үргэлж stretch байрлал ашиглана." }),
  permission: Schema.optional(ConfigPermissionV1.Info),
  tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  attachment: Schema.optional(ConfigAttachmentV1.Info).annotate({
    description: "Хавсралт боловсруулах тохиргоо, үүнд зургийн хэмжээний хязгаар болон хэмжээг өөрчлөх үйлдэл багтана",
  }),
  enterprise: Schema.optional(
    Schema.Struct({ url: Schema.optional(Schema.String).annotate({ description: "Enterprise-ийн URL" }) }),
  ),
  tool_output: Schema.optional(
    Schema.Struct({
      max_lines: Schema.optional(PositiveInt).annotate({
        description: "Хэрэгслийн гаралт таслагдаж дискэнд хадгалагдахаас өмнөх мөрийн дээд тоо (анхдагч: 2000)",
      }),
      max_bytes: Schema.optional(PositiveInt).annotate({
        description: "Хэрэгслийн гаралт таслагдаж дискэнд хадгалагдахаас өмнөх байтын дээд хэмжээ (анхдагч: 51200)",
      }),
    }),
  ).annotate({
    description:
      "Хэрэгслийн гаралтыг таслах хязгаарууд. Гаралт аль нэг хязгаараас хэтэрвэл бүтэн текстийг тасалсан гаралтын хавтаст хадгалж, урьдчилж харах хэсгийг буцаана.",
  }),
  compaction: Schema.optional(
    Schema.Struct({
      auto: Schema.optional(Schema.Boolean).annotate({
        description: "Контекст дүүрсэн үед автоматаар нягтруулахыг идэвхжүүлнэ (анхдагч: true)",
      }),
      prune: Schema.optional(Schema.Boolean).annotate({
        description: "Хуучин хэрэгслийн гаралтыг цэвэрлэхийг идэвхжүүлнэ (анхдагч: false)",
      }),
      tail_turns: Schema.optional(NonNegativeInt).annotate({
        description:
          "Нягтруулах үед өөрчлөлтгүй хадгалах сүүлийн хэрэглэгчийн ээлжийн тоо. Үүнд дараах туслах болон хэрэгслийн хариунууд мөн багтана (анхдагч: 2)",
      }),
      preserve_recent_tokens: Schema.optional(NonNegativeInt).annotate({
        description: "Нягтруулсны дараа сүүлийн ээлжүүдээс өөрчлөлтгүй хадгалах токены дээд тоо",
      }),
      reserved: Schema.optional(NonNegativeInt).annotate({
        description: "Нягтруулалтад үлдээх токены нөөц. Нягтруулах үед хэтрэлтээс сэргийлэх хангалттай контекстийн багтаамж үлдээнэ.",
      }),
    }),
  ),
  experimental: Schema.optional(
    Schema.Struct({
      disable_paste_summary: Schema.optional(Schema.Boolean),
      batch_tool: Schema.optional(Schema.Boolean).annotate({ description: "Багц хэрэгслийг идэвхжүүлнэ" }),
      openTelemetry: Schema.optional(Schema.Boolean).annotate({
        description: "AI SDK дуудлагад OpenTelemetry span идэвхжүүлнэ ('experimental_telemetry' тугийг ашиглана)",
      }),
      primary_tools: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
        description: "Зөвхөн үндсэн агентуудад ашиглах боломжтой хэрэгслүүд.",
      }),
      continue_loop_on_deny: Schema.optional(Schema.Boolean).annotate({
        description: "Хэрэгсэл дуудах хүсэлтийг татгалзсан үед агентын давталтыг үргэлжлүүлнэ",
      }),
      mcp_timeout: Schema.optional(PositiveInt).annotate({
        description: "Model Context Protocol (MCP) хүсэлтийн миллисекундээр илэрхийлсэн хүлээлгийн хугацаа",
      }),
      policies: Schema.optional(Schema.mutable(Schema.Array(ConfigExperimental.Policy))).annotate({
        description: "Үйлчилгээ үзүүлэгчийн хандалт зэрэг дэмжигдсэн нөөцөд хэрэгжүүлэх бодлогын дүрмүүд",
      }),
    }),
  ),
}).annotate({ identifier: "Config" })

export type Info = DeepMutable<Schema.Schema.Type<typeof Info>>
