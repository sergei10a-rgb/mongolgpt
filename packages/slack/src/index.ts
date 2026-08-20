import { App } from "@slack/bolt"
import { createMongolGPT, type ToolPart } from "@mongolgpt/sdk"

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
})

console.log("Bot-ын тохиргоо:")
console.log("- Bot token байгаа эсэх:", !!process.env.SLACK_BOT_TOKEN)
console.log("- Гарын үсгийн нууц утга байгаа эсэх:", !!process.env.SLACK_SIGNING_SECRET)
console.log("- App token байгаа эсэх:", !!process.env.SLACK_APP_TOKEN)

console.log("MongolGPT серверийг эхлүүлж байна...")
const mongolgpt = await createMongolGPT({
  port: 0,
})
console.log("MongolGPT сервер бэлэн боллоо")

const sessions = new Map<string, { client: any; server: any; sessionId: string; channel: string; thread: string }>()
void (async () => {
  const events = await mongolgpt.client.event.subscribe()
  for await (const event of events.stream) {
    if (event.type === "message.part.updated") {
      const part = event.properties.part
      if (part.type === "tool") {
        // Find the session for this tool update
        for (const [_sessionKey, session] of sessions.entries()) {
          if (session.sessionId === part.sessionID) {
            void handleToolUpdate(part, session.channel, session.thread)
            break
          }
        }
      }
    }
  }
})()

async function handleToolUpdate(part: ToolPart, channel: string, thread: string) {
  if (part.state.status !== "completed") return
  const toolMessage = `*${part.tool}* - ${part.state.title}`
  await app.client.chat
    .postMessage({
      channel,
      thread_ts: thread,
      text: toolMessage,
    })
    .catch(() => {})
}

app.use(async ({ next, context }) => {
  console.log("Slack-ийн эх үйл явдал:", JSON.stringify(context, null, 2))
  await next()
})

app.message(async ({ message, say }) => {
  console.log("Хүлээн авсан зурвасын үйл явдал:", JSON.stringify(message, null, 2))

  if (message.subtype || !("text" in message) || !message.text) {
    console.log("Зурваст текст байхгүй эсвэл subtype-тай тул алгаслаа")
    return
  }

  console.log("Зурвасыг боловсруулж байна:", message.text)

  const channel = message.channel
  const thread = (message as any).thread_ts || message.ts
  const sessionKey = `${channel}-${thread}`

  let session = sessions.get(sessionKey)

  if (!session) {
    console.log("Шинэ MongolGPT сешн үүсгэж байна...")
    const { client, server } = mongolgpt

    const createResult = await client.session.create({
      body: { title: `Slack хэлхээ ${thread}` },
    })

    if (createResult.error) {
      console.error("Сешн үүсгэж чадсангүй:", createResult.error)
      await say({
        text: "Уучлаарай, сешн үүсгэхэд алдаа гарлаа. Дахин оролдоно уу.",
        thread_ts: thread,
      })
      return
    }

    console.log("MongolGPT сешн үүсгэлээ:", createResult.data.id)

    session = { client, server, sessionId: createResult.data.id, channel, thread }
    sessions.set(sessionKey, session)

    const shareResult = await client.session.share({ path: { id: createResult.data.id } })
    if (!shareResult.error && shareResult.data) {
      const sessionUrl = shareResult.data.share?.url
      console.log("Сешнийг хуваалцлаа:", sessionUrl)
      await app.client.chat.postMessage({ channel, thread_ts: thread, text: sessionUrl })
    }
  }

  console.log("MongolGPT рүү илгээж байна:", message.text)
  const result = await session.client.session.prompt({
    path: { id: session.sessionId },
    body: { parts: [{ type: "text", text: message.text }] },
  })

  console.log("MongolGPT-ийн хариу:", JSON.stringify(result, null, 2))

  if (result.error) {
    console.error("Зурвас илгээж чадсангүй:", result.error)
    await say({
      text: "Уучлаарай, таны зурвасыг боловсруулахад алдаа гарлаа. Дахин оролдоно уу.",
      thread_ts: thread,
    })
    return
  }

  const response = result.data

  // Build response text
  const responseText =
    response.info?.content ||
    response.parts
      ?.filter((p: any) => p.type === "text")
      .map((p: any) => p.text)
      .join("\n") ||
    "Таны зурвасыг хүлээн авлаа, гэхдээ хариу үүссэнгүй."

  console.log("Хариуг илгээж байна:", responseText)

  // Send main response (tool updates will come via live events)
  await say({ text: responseText, thread_ts: thread })
})

app.command("/test", async ({ command, ack, say }) => {
  await ack()
  console.log("Туршилтын команд хүлээн авлаа:", JSON.stringify(command, null, 2))
  await say("Bot ажиллаж байна. Таны зурвасыг хүлээн авлаа.")
})

await app.start()
console.log("Slack bot ажиллаж байна")
