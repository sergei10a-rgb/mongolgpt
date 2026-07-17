import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Database as SQLite, type SQLQueryBindings } from "bun:sqlite"
import { resolve } from "node:path"
import {
  InvalidNewsletterSubscriptionError,
  newsletterConsentVersion,
  subscribeNewsletter,
} from "../src/newsletter"

let sqlite: SQLite

const database = {
  prepare(query: string) {
    let parameters: SQLQueryBindings[] = []
    const statement = {
      bind(...values: SQLQueryBindings[]) {
        parameters = values
        return statement
      },
      async run() {
        sqlite.query(query).run(...parameters)
        return { success: true }
      },
    }
    return statement
  },
} as unknown as D1Database

async function migrationSql() {
  const directory = resolve(import.meta.dir, "../migrations-d1")
  const paths: string[] = []
  for await (const path of new Bun.Glob("*/migration.sql").scan({ cwd: directory, absolute: true })) paths.push(path)
  return (await Promise.all(paths.sort().map((path) => Bun.file(path).text()))).join("\n")
}

describe("Cloudflare D1 мэдээллийн захидал", () => {
  beforeEach(async () => {
    sqlite = new SQLite(":memory:")
    sqlite.exec(await migrationSql())
  })

  afterEach(() => sqlite.close())

  test("и-мэйл болон хэлний утгыг цэвэрлэж зөвшөөрлийн хамт хадгална", async () => {
    await subscribeNewsletter({ email: "  USER@Example.COM ", locale: "MN", source: "stats" }, database)

    const subscriber = sqlite.query("select * from newsletter_subscriber where email = ?").get("user@example.com") as {
      email: string
      locale: string
      source: string
      status: string
      consent_version: string
    }
    expect(subscriber).toMatchObject({
      email: "user@example.com",
      locale: "mn",
      source: "stats",
      status: "active",
      consent_version: newsletterConsentVersion,
    })
  })

  test("цуцалсан бүртгэлийг давтан хүсэлтээр идэвхжүүлнэ", async () => {
    await subscribeNewsletter({ email: "user@example.com", locale: "mn", source: "stats" }, database)
    sqlite
      .query("update newsletter_subscriber set status = 'unsubscribed', time_unsubscribed = ? where email = ?")
      .run(1, "user@example.com")

    await subscribeNewsletter({ email: "USER@example.com", locale: "en", source: "console" }, database)

    const subscriber = sqlite
      .query("select status, locale, source, time_unsubscribed from newsletter_subscriber where email = ?")
      .get("user@example.com") as { status: string; locale: string; source: string; time_unsubscribed: number | null }
    expect(subscriber).toEqual({ status: "active", locale: "en", source: "console", time_unsubscribed: null })
  })

  test("буруу и-мэйл хаягийг D1-д бичихгүй", async () => {
    for (const email of ["not-an-email", ".user@example.com", "user@example..com", "user@-example.com"]) {
      await expect(subscribeNewsletter({ email, source: "stats" }, database)).rejects.toBeInstanceOf(
        InvalidNewsletterSubscriptionError,
      )
    }
    expect(sqlite.query("select count(*) as count from newsletter_subscriber").get()).toEqual({ count: 0 })
  })
})
