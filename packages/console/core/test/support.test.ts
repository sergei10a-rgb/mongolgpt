import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { drizzle, type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import { resolve } from "node:path"
import {
  SupportError,
  createSupportTicketWithDb,
  getAccountSupportTicketWithDb,
  listAccountSupportTicketsWithDb,
  redactSupportSecrets,
  replyToSupportTicketWithDb,
} from "../src/support"
import { Database } from "../src/drizzle"
import * as schema from "../src/schema-d1"

let sqlite: SQLite
let db: Database.TxOrDb

async function migrations() {
  const directory = resolve(import.meta.dir, "../migrations-d1")
  const paths: string[] = []
  for await (const path of new Bun.Glob("*/migration.sql").scan({ cwd: directory, absolute: true })) paths.push(path)
  return (await Promise.all(paths.sort().map((path) => Bun.file(path).text()))).join("\n")
}

async function ticket(
  accountID = "acc_one",
  overrides: Partial<{
    workspaceID: string
    subject: string
    category: "account" | "billing" | "technical" | "feedback" | "other"
    message: string
  }> = {},
) {
  return createSupportTicketWithDb(db, {
    accountID,
    requesterEmail: `${accountID}@mgpt.mn`,
    subject: overrides.subject ?? "Тусламж хэрэгтэй байна",
    category: overrides.category ?? "technical",
    message: overrides.message ?? "Програм ажиллахгүй байна.",
    ...(overrides.workspaceID ? { workspaceID: overrides.workspaceID } : {}),
  })
}

function addAccount(id: string, status = "active") {
  sqlite
    .query("insert into account (id, status, suspension_reason, suspended_by, time_suspended) values (?, ?, ?, ?, ?)")
    .run(
      id,
      status,
      status === "suspended" ? "Дүрэм зөрчсөн хэрэглэгч" : null,
      status === "suspended" ? "adm_01" : null,
      status === "suspended" ? 1 : null,
    )
}

function addMember(accountID: string, workspaceID = "wrk_one") {
  sqlite.query("insert or ignore into workspace (id, name) values (?, ?)").run(workspaceID, "Баг")
  sqlite
    .query("insert into user (id, workspace_id, account_id, name, role) values (?, ?, ?, ?, ?)")
    .run(`usr_${accountID}`, workspaceID, accountID, "Хэрэглэгч", "member")
}

describe("Support core", () => {
  beforeEach(async () => {
    sqlite = new SQLite(":memory:")
    sqlite.exec(await migrations())
    const drizzleDb: SQLiteBunDatabase<typeof schema> = drizzle({ client: sqlite, schema })
    db = drizzleDb as unknown as Database.TxOrDb
    addAccount("acc_one")
    addAccount("acc_two")
  })

  afterEach(() => sqlite.close())

  test("үүсгэх, жагсаах, дэлгэрэнгүй харах нь account-аар тусгаарлагдана", async () => {
    const created = await ticket()
    await expect(
      getAccountSupportTicketWithDb(db, { accountID: "acc_two", ticketID: created.id }),
    ).rejects.toMatchObject({ code: "not_found" })
    expect((await listAccountSupportTicketsWithDb(db, { accountID: "acc_one" })).items).toHaveLength(1)
    const detail = await getAccountSupportTicketWithDb(db, { accountID: "acc_one", ticketID: created.id })
    expect(detail.ticket.requester_email).toBe("acc_one@mgpt.mn")
    expect(detail.ticket).not.toHaveProperty("assigned_admin_id")
    expect(detail.ticket).not.toHaveProperty("account_id")
    expect((await listAccountSupportTicketsWithDb(db, { accountID: "acc_one" })).items[0]).not.toHaveProperty(
      "assigned_admin_id",
    )
    expect(detail.messages).toHaveLength(1)
  })

  test("workspace membership болон suspended account-ыг шалгана", async () => {
    await expect(ticket("acc_one", { workspaceID: "wrk_missing" })).rejects.toMatchObject({ code: "membership" })
    addMember("acc_one")
    await expect(ticket("acc_one", { workspaceID: "wrk_one" })).resolves.toBeDefined()
    addAccount("acc_suspended", "suspended")
    await expect(ticket("acc_suspended")).rejects.toMatchObject({ code: "suspended" })
  })

  test("төрөл, урт, нууц утгыг хатуу шалгаж халхална", async () => {
    await expect(ticket("acc_one", { category: "technical", subject: "x".repeat(161) })).rejects.toMatchObject({
      code: "invalid",
    })
    const created = await ticket("acc_one", {
      subject: "api_key=sk-secret-token",
      message: "Authorization: Bearer eyJabcdefgh.abcdefgh.abcdefgh",
    })
    const row = sqlite.query("select subject from support_ticket where id = ?").get(created.id) as { subject: string }
    const message = sqlite.query("select body from support_message where ticket_id = ?").get(created.id) as {
      body: string
    }
    expect(`${row.subject} ${message.body}`).not.toContain("sk-secret-token")
    expect(`${row.subject} ${message.body}`).toContain("[НУУЦ ХАЛХЛАВ]")
    expect(redactSupportSecrets("tokenize=okay; token = abcdefghijk")).toBe("tokenize=okay; token = [НУУЦ ХАЛХЛАВ]")
    expect(redactSupportSecrets('{"apiKey": "sk-private-value", "password": "two words"}')).toBe(
      '{"apiKey": "[НУУЦ ХАЛХЛАВ]", "password": "[НУУЦ ХАЛХЛАВ]"}',
    )
    expect(redactSupportSecrets("Bearer opaque-token-value")).toBe("Bearer [НУУЦ ХАЛХЛАВ]")
    await expect(
      listAccountSupportTicketsWithDb(db, { accountID: "acc_one", cursor: `${"9".repeat(40)}:${created.id}` }),
    ).rejects.toMatchObject({ code: "invalid" })
  })

  test("open болон 24 цагийн ticket хязгаарыг DB query-гаар мөрдөнө", async () => {
    for (let index = 0; index < 10; index++) await ticket("acc_one", { subject: `Хүсэлт ${index}` })
    await expect(ticket("acc_one", { subject: "Илүү" })).rejects.toMatchObject({ code: "rate_limit" })
    sqlite
      .query("update support_ticket set status = 'resolved', time_resolved = ?, time_updated = ? where account_id = ?")
      .run(Date.now(), Date.now(), "acc_one")
    for (let index = 0; index < 10; index++) await ticket("acc_one", { subject: `Шинэ ${index}` })
    await expect(ticket("acc_one", { subject: "24 цагийн илүү" })).rejects.toMatchObject({ code: "rate_limit" })
  })

  test("reply CAS, closed state, internal visibility, 200 cap болон trigger-ийг мөрдөнө", async () => {
    const created = await ticket()
    const replied = await replyToSupportTicketWithDb(db, {
      accountID: "acc_one",
      ticketID: created.id,
      message: "Дахин тайлбарлая.",
      expectedLockVersion: 0,
    })
    expect(replied).toMatchObject({ status: "pending_support", lockVersion: 1 })
    await expect(
      replyToSupportTicketWithDb(db, {
        accountID: "acc_one",
        ticketID: created.id,
        message: "Зэрэгцсэн хариу",
        expectedLockVersion: 0,
      }),
    ).rejects.toMatchObject({ code: "conflict" })
    sqlite
      .query(
        "insert into support_message (id, ticket_id, author_type, admin_id, body, internal, time_created) values (?, ?, 'admin', ?, ?, 1, ?)",
      )
      .run(`spm_${"A".repeat(26)}`, created.id, "adm_01", "Дотоод тэмдэглэл", Date.now())
    expect(
      (await getAccountSupportTicketWithDb(db, { accountID: "acc_one", ticketID: created.id })).messages.map(
        (message) => message.body,
      ),
    ).not.toContain("Дотоод тэмдэглэл")
    expect(() =>
      sqlite.query("update support_message set body = 'x' where id = ?").run(`spm_${"A".repeat(26)}`),
    ).toThrow("support_message is immutable")
    sqlite
      .query("update support_ticket set status = 'resolved', time_resolved = ?, time_updated = ? where id = ?")
      .run(Date.now(), Date.now(), created.id)
    await expect(
      replyToSupportTicketWithDb(db, {
        accountID: "acc_one",
        ticketID: created.id,
        message: "Хаасан дараах",
        expectedLockVersion: 1,
      }),
    ).rejects.toMatchObject({ code: "closed" })
    const capped = await ticket("acc_one", { subject: "Дээд хязгаар" })
    for (let index = 0; index < 199; index++)
      sqlite
        .query(
          "insert into support_message (id, ticket_id, author_type, admin_id, body, internal, time_created) values (?, ?, 'admin', ?, ?, 0, ?)",
        )
        .run(`spm_${String(index).padStart(26, "B")}`, capped.id, "adm_01", `Хариу ${index}`, Date.now() + index)
    expect(
      (await getAccountSupportTicketWithDb(db, { accountID: "acc_one", ticketID: capped.id })).messages,
    ).toHaveLength(200)
    await expect(
      replyToSupportTicketWithDb(db, {
        accountID: "acc_one",
        ticketID: capped.id,
        message: "Нэмэлт хариу",
        expectedLockVersion: 0,
      }),
    ).rejects.toMatchObject({ code: "rate_limit" })
  })

  test("error нь Mongolian code-тай байна", () => {
    const error = new SupportError("forbidden", "Хандах эрхгүй байна.")
    expect(error).toMatchObject({ code: "forbidden", message: "Хандах эрхгүй байна." })
  })
})
