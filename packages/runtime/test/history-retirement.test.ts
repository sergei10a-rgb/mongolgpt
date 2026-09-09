import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createHistoryStore, HistoryError } from "../src/history"

const scope = { accountID: "acc_retirement", workspaceID: "wrk_retirement" }

test("the forward migration preserves pre-existing history and fences old SQL writers", async () => {
  const db = new Database(":memory:")
  try {
    db.exec("PRAGMA foreign_keys = ON")
    for (const name of ["0001_history.sql", "0002_history_checkpoint.sql", "0003_file_revision.sql"])
      db.exec(await Bun.file(new URL(`../migrations/${name}`, import.meta.url)).text())
    db.exec("INSERT INTO runtime_history_writer VALUES ('acc_old', 'wrk_old', 1, 'writer_old')")
    db.exec(
      "INSERT INTO runtime_history_session (account_id, workspace_id, session_id, seq) VALUES ('acc_old', 'wrk_old', 'ses_old', 0)",
    )
    db.exec(
      "INSERT INTO runtime_history_event (account_id, workspace_id, session_id, event_id, seq, type, data, digest, deleted) VALUES ('acc_old', 'wrk_old', 'ses_old', 'evt_old', 0, 'session.created.1', '{\"text\":\"preserved\"}', 'digest', 0)",
    )
    const before = db.query("SELECT * FROM runtime_history_event").all()
    db.exec(await Bun.file(new URL("../migrations/0004_account_retirement.sql", import.meta.url)).text())
    expect(db.query("SELECT * FROM runtime_history_event").all()).toEqual(before)
    expect(db.query("SELECT * FROM runtime_history_retirement").all()).toEqual([])
    db.exec("UPDATE runtime_history_writer SET epoch = 2 WHERE account_id = 'acc_old'")
    db.exec("INSERT INTO runtime_history_retirement VALUES ('acc_old')")
    expect(() => db.exec("UPDATE runtime_history_writer SET epoch = 3 WHERE account_id = 'acc_old'")).toThrow(
      "runtime_account_retired",
    )
    expect(db.query("SELECT * FROM runtime_history_event").all()).toEqual(before)
  } finally {
    db.close()
  }
})

test("sanitizes failed admission and retirement even when D1 prepare throws synchronously", async () => {
  const store = createHistoryStore({
    prepare() {
      throw new Error("private SQL credential detail")
    },
    async batch() {
      throw new Error("private batch detail")
    },
  })
  for (const operation of [() => store.assertActive(scope), () => store.retire(scope.accountID)]) {
    await expect(operation()).rejects.toMatchObject({
      code: "unavailable",
      message: new HistoryError("unavailable").message,
    })
  }
})

test("invalid retirement identifiers never reach storage", async () => {
  let touched = false
  const store = createHistoryStore({
    prepare() {
      touched = true
      throw new Error("unexpected storage access")
    },
    async batch() {
      touched = true
      throw new Error("unexpected storage access")
    },
  })
  for (const id of ["", "../acc_other", "acc/other", "acc%2Fother", "a".repeat(257)])
    await expect(store.retire(id)).rejects.toMatchObject({ code: "invalid_input" })
  expect(touched).toBe(false)
})
