import { z } from "zod"
import { Resource } from "@mongolgpt/console-resource"
import { AwsClient } from "aws4fetch"
import { fn } from "./util/fn"

export namespace AWS {
  let client: AwsClient

  const createClient = () => {
    if (!client) {
      client = new AwsClient({
        accessKeyId: Resource.AWS_SES_ACCESS_KEY_ID.value,
        secretAccessKey: Resource.AWS_SES_SECRET_ACCESS_KEY.value,
        region: "us-east-1",
      })
    }
    return client
  }

  export const sendEmail = fn(
    z.object({
      to: z.string(),
      subject: z.string(),
      body: z.string(),
      from: z.string().optional(),
      replyTo: z.string().optional(),
    }),
    async (input) => {
      const from = input.from ?? process.env.MONGOLGPT_SES_FROM_EMAIL
      if (!from) throw new Error("MONGOLGPT_SES_FROM_EMAIL is required before sending email")

      const res = await createClient().fetch("https://email.us-east-1.amazonaws.com/v2/email/outbound-emails", {
        method: "POST",
        headers: {
          "X-Amz-Target": "SES.SendEmail",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          FromEmailAddress: from,
          Destination: {
            ToAddresses: [input.to],
          },
          ...(input.replyTo && { ReplyToAddresses: [input.replyTo] }),
          Content: {
            Simple: {
              Subject: {
                Charset: "UTF-8",
                Data: input.subject,
              },
              Body: {
                Text: {
                  Charset: "UTF-8",
                  Data: input.body,
                },
                Html: {
                  Charset: "UTF-8",
                  Data: input.body,
                },
              },
            },
          },
        }),
      })
      if (!res.ok) {
        throw new Error(`Failed to send email: ${res.statusText}`)
      }
    },
  )
}
