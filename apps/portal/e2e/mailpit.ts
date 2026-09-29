import { expect } from "@playwright/test"

import { e2eEnv } from "./env"

const { mailpitUrl } = e2eEnv()

/**
 * The first link in the newest mail to `to` whose subject contains `subject`, once at
 * least `count` such mails have arrived. Polls, because the mail can arrive after the
 * response to the request that sent it.
 */
export async function linkFromMail(
  to: string,
  subject: string,
  count = 1
): Promise<string> {
  let text = ""
  await expect
    .poll(
      async () => {
        const query = encodeURIComponent(`to:"${to}" subject:"${subject}"`)
        const res = await fetch(`${mailpitUrl}/api/v1/search?query=${query}`)
        const { messages } = (await res.json()) as {
          messages: { ID: string }[]
        }
        if (messages.length < count) return false
        const msg = await fetch(
          `${mailpitUrl}/api/v1/message/${messages[0].ID}`
        )
        text = ((await msg.json()) as { Text: string }).Text
        return true
      },
      { message: `mail "${subject}" to ${to}`, timeout: 15_000 }
    )
    .toBe(true)
  const link = text.match(/https?:\/\/\S+/)?.[0]
  if (!link) throw new Error(`no link in mail "${subject}" to ${to}:\n${text}`)
  return link
}
