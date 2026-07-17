import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Database as SQLite, type SQLQueryBindings } from "bun:sqlite"
import { resolve } from "node:path"
import {
  enterpriseInquiryFormVersion,
  InvalidEnterpriseInquiryError,
  submitEnterpriseInquiry,
} from "../src/enterprise-inquiry"

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

describe("Cloudflare D1 enterprise хүсэлт", () => {
  beforeEach(async () => {
    sqlite = new SQLite(":memory:")
    sqlite.exec(await migrationSql())
  })

  afterEach(() => sqlite.close())

  test("хүсэлтийг цэвэрлэж, төлөв болон form хувилбартай хадгална", async () => {
    const result = await submitEnterpriseInquiry(
      {
        name: "  Бат Болд  ",
        role: " Захирал ",
        company: " Монгол ХХК ",
        email: "BOLD@EXAMPLE.COM",
        phone: " 99112233 ",
        message: " MongolGPT Enterprise-ийн талаар холбогдоно уу. ",
        locale: "MN",
      },
      database,
    )

    const inquiry = sqlite.query("select * from enterprise_inquiry where id = ?").get(result.id) as {
      name: string
      email: string
      locale: string
      source: string
      status: string
      form_version: string
    }
    expect(inquiry).toMatchObject({
      name: "Бат Болд",
      email: "bold@example.com",
      locale: "mn",
      source: "enterprise",
      status: "new",
      form_version: enterpriseInquiryFormVersion,
    })
  })

  test("дутуу эсвэл буруу хүсэлтийг D1-д бичихгүй", async () => {
    await expect(
      submitEnterpriseInquiry(
        { name: "Бат", role: "Захирал", email: "wrong", message: "Холбогдоно уу." },
        database,
      ),
    ).rejects.toBeInstanceOf(InvalidEnterpriseInquiryError)
    expect(sqlite.query("select count(*) as count from enterprise_inquiry").get()).toEqual({ count: 0 })
  })
})
