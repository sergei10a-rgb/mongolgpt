import { Argument, Flag } from "effect/unstable/cli"
import { Spec } from "../framework/spec"

declare const MONGOLGPT_CLI_NAME: string | undefined

export const Commands = Spec.make(typeof MONGOLGPT_CLI_NAME === "string" ? MONGOLGPT_CLI_NAME : "mongolgpt", {
  description: "MongolGPT 2.0 урьдчилсан хувилбарын командын мөрийн интерфэйс",
  commands: [
    Spec.make("api", {
      description: "Ажиллаж буй сервер рүү хүсэлт илгээх",
      params: {
        request: Argument.string("operation | method path").pipe(
          Argument.withDescription("OpenAPI ажиллагааны ID эсвэл HTTP арга ба path"),
          Argument.variadic({ min: 1, max: 2 }),
        ),
        data: Flag.string("data").pipe(Flag.withAlias("d"), Flag.withDescription("Хүсэлтийн body"), Flag.optional),
        header: Flag.string("header").pipe(
          Flag.withAlias("H"),
          Flag.withDescription("name:value хэлбэрийн хүсэлтийн header"),
          Flag.atMost(100),
        ),
        param: Flag.keyValuePair("param").pipe(
          Flag.withDescription("OpenAPI path эсвэл query parameter"),
          Flag.optional,
        ),
      },
    }),
    Spec.make("debug", {
      description: "Дибаг болон асуудал оношлох хэрэгслүүд",
      commands: [Spec.make("agents", { description: "Бүх agent-ийг жагсаах" })],
    }),
    Spec.make("migrate", { description: "v1 өгөгдлийг v2 руу шилжүүлэх" }),
    Spec.make("service", {
      description: "Арын серверийг удирдах",
      commands: [
        Spec.make("start", { description: "Арын серверийг эхлүүлэх" }),
        Spec.make("restart", { description: "Арын серверийг дахин эхлүүлэх" }),
        Spec.make("status", { description: "Арын серверийн төлөвийг харуулах" }),
        Spec.make("stop", { description: "Арын серверийг зогсоох" }),
        Spec.make("password", {
          description: "Серверийн password авах эсвэл тохируулах",
          params: { value: Argument.string("value").pipe(Argument.optional) },
        }),
      ],
    }),
    Spec.make("serve", {
      description: "v2 API сервер эхлүүлэх",
      params: {
        hostname: Flag.string("hostname").pipe(Flag.withDefault("127.0.0.1")),
        port: Flag.integer("port").pipe(Flag.optional),
        register: Flag.boolean("register").pipe(Flag.withDefault(false)),
      },
    }),
  ],
})
