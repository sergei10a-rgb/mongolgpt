import { Plugin } from "./index.js"
import { tool } from "./tool.js"

export const ExamplePlugin: Plugin = async (_ctx) => {
  return {
    tool: {
      mytool: tool({
        description: "Энэ бол тусгай хэрэгсэл",
        args: {
          foo: tool.schema.string().describe("foo"),
        },
        async execute(args) {
          return `Сайн байна уу, ${args.foo}!`
        },
      }),
    },
  }
}
