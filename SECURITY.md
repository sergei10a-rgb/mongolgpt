# Аюулгүй байдал

## Чухал

AI-аар автоматаар үүсгэсэн security report хүлээн авахгүй. Ийм report маш их ирдэг бөгөөд бүгдийг нь шалгах нөөц байхгүй. Ийм report явуулбал project-оос автоматаар ban хийх боломжтой.

## Аюулын загвар

### Ерөнхий ойлголт

MongolGPT бол таны компьютерт локалаар ажиллах AI coding assistant юм. Энэ нь shell command ажиллуулах, файл унших/бичих, web access хийх зэрэг хүчтэй tool-уудтай agent system ажиллуулдаг.

### Sandbox биш

MongolGPT agent-ийг бүрэн sandbox хийдэггүй. Permission system нь хэрэглэгч agent юу хийх гэж байгааг харах, command ажиллуулах эсвэл файл бичихээс өмнө confirm авах UX хамгаалалт юм. Энэ нь security isolation хийх зориулалттай sandbox биш.

Жинхэнэ тусгаарлалт хэрэгтэй бол MongolGPT-ийг Docker container эсвэл VM дотор ажиллуулна уу.

### Сервер горим

Сервер горим нь зөвхөн хэрэглэгч өөрөө асаасан үед ажиллана. Асаах бол `MONGOLGPT_SERVER_PASSWORD` тохируулж HTTP Basic Auth шаардах хэрэгтэй. Үүнийг тохируулаагүй бол сервер баталгаажуулалтгүй ажиллана, гэхдээ warning харуулна. Серверээ хамгаалах нь тухайн хэрэглэгчийн хариуцлага.

### Scope-д хамаарахгүй зүйлс

| Ангилал | Шалтгаан |
| --- | --- |
| **Сервер горимыг өөрөө асаасан үед API access авах** | Сервер горим асаасан бол API access нь expected behavior |
| **Sandbox escape** | Permission system нь sandbox биш |
| **LLM provider-ийн data handling** | Таны сонгосон LLM provider руу илгээсэн data нь provider-ийн policy-д захирагдана |
| **MCP server-ийн behavior** | Таны тохируулсан external MCP server-үүд MongolGPT-ийн trust boundary-оос гадуур |
| **Malicious config file** | Хэрэглэгч өөрийн config-оо удирддаг тул config өөрчлөх нь vulnerability биш |

## Аюулгүй байдлын асуудал мэдэгдэх

Аюулгүй байдлын асуудал олсон бол GitHub Security Advisory-ийн **Report a Vulnerability** табаар мэдэгдэнэ үү.

[https://github.com/sergei10a-rgb/mongolgpt/security/advisories/new](https://github.com/sergei10a-rgb/mongolgpt/security/advisories/new)

Бид report авсны дараа дараагийн алхмыг хариу мэдэгдэнэ. Шаардлагатай бол нэмэлт мэдээлэл асууж болно.
