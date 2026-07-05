// @ts-nocheck

import { MongolGPT } from "@mongolgpt/core"
import { ReadTool } from "@mongolgpt/core/tools"

const mongolgpt = MongolGPT.make({})

mongolgpt.tool.add(ReadTool)

mongolgpt.tool.add({
  name: "bash",
  schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The command to run.",
      },
    },
    required: ["command"],
  },
  execute(input, ctx) {},
})

mongolgpt.auth.add({
  provider: "openai",
  type: "api",
  value: process.env.OPENAI_API_KEY,
})

mongolgpt.agent.add({
  name: "build",
  permissions: [],
  model: {
    id: "gpt-5-5",
    provider: "openai",
    variant: "xhigh",
  },
})

const sessionID = await mongolgpt.session.create({
  agent: "build",
})

mongolgpt.subscribe((event) => {
  console.log(event)
})

await mongolgpt.session.prompt({
  sessionID,
  text: "hey what is up",
})

await mongolgpt.session.prompt({
  sessionID,
  text: "what is up with this",
  files: [
    {
      mime: "image/png",
      uri: "data:image/png;base64,xxxx",
    },
  ],
})

await mongolgpt.session.wait()

console.log(await mongolgpt.session.messages(sessionID))
