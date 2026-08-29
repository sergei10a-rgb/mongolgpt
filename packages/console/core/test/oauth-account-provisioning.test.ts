import { describe, expect, test } from "bun:test";
import { Database as SQLite } from "bun:sqlite";
import { drizzle, type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";
import { resolve } from "node:path";
import type { Database as CoreDatabase } from "../src/drizzle";
import {
  OAuthIdentityConflictError,
  provisionOAuthAccountIdentity,
} from "../src/oauth-account-provisioning";
import * as schema from "../src/schema-d1";

async function migrationSql() {
  const directory = resolve(import.meta.dir, "../migrations-d1");
  const paths: string[] = [];

  for await (const path of new Bun.Glob("*/migration.sql").scan({
    cwd: directory,
    absolute: true,
  })) {
    paths.push(path);
  }

  return (
    await Promise.all(paths.sort().map((path) => Bun.file(path).text()))
  ).join("\n");
}

async function fixture() {
  const sqlite = new SQLite(":memory:");
  sqlite.exec(await migrationSql());
  const drizzleDb: SQLiteBunDatabase<typeof schema> = drizzle({
    client: sqlite,
    schema,
  });
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- D1 and Bun SQLite expose the same Drizzle query surface for this invariant test.
  const db = drizzleDb as unknown as CoreDatabase.TxOrDb;
  let transactionTail = Promise.resolve();
  const transaction = async <T>(
    callback: (tx: CoreDatabase.TxOrDb) => Promise<T>,
  ) => {
    const previous = transactionTail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    transactionTail = previous.then(() => current);
    await previous;

    sqlite.exec("BEGIN IMMEDIATE");
    try {
      const result = await callback(db);
      sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw error;
    } finally {
      release();
    }
  };

  return { sqlite, transaction };
}

describe("OAuth account provisioning", () => {
  test("keeps first login account and identities in one transaction invariant", async () => {
    const { sqlite, transaction } = await fixture();

    const result = await provisionOAuthAccountIdentity(
      {
        provider: "github",
        subject: "1001",
        email: "owner@mgpt.mn",
      },
      { transaction },
    );

    expect(result.newAccount).toBe(true);
    expect(sqlite.query("select count(*) as count from account").get()).toEqual(
      { count: 1 },
    );
    expect(sqlite.query("select count(*) as count from auth").get()).toEqual({
      count: 2,
    });
    expect(
      sqlite
        .query(
          "select provider, subject, account_id from auth order by provider",
        )
        .all(),
    ).toEqual([
      {
        provider: "email",
        subject: "owner@mgpt.mn",
        account_id: result.accountID,
      },
      { provider: "github", subject: "1001", account_id: result.accountID },
    ]);
  });

  test("is idempotent when duplicate first-login callbacks arrive together", async () => {
    const { sqlite, transaction } = await fixture();
    const input = {
      provider: "github" as const,
      subject: "1001",
      email: "owner@mgpt.mn",
    };

    const [first, second] = await Promise.all([
      provisionOAuthAccountIdentity(input, { transaction }),
      provisionOAuthAccountIdentity(input, { transaction }),
    ]);

    expect(first.accountID).toBe(second.accountID);
    expect(first.newAccount).toBe(true);
    expect(second.newAccount).toBe(false);
    expect(sqlite.query("select count(*) as count from account").get()).toEqual(
      { count: 1 },
    );
    expect(sqlite.query("select count(*) as count from auth").get()).toEqual({
      count: 2,
    });
    expect(
      sqlite
        .query(
          "select count(*) as count from auth where account_id not in (select id from account)",
        )
        .get(),
    ).toEqual({
      count: 0,
    });
  });

  test("links a new provider identity to an existing email account", async () => {
    const { sqlite, transaction } = await fixture();
    sqlite.query("insert into account (id) values (?)").run("acc_existing");
    sqlite
      .query(
        "insert into auth (id, provider, subject, account_id) values (?, 'email', ?, ?)",
      )
      .run("auth_existing_email", "owner@mgpt.mn", "acc_existing");

    const result = await provisionOAuthAccountIdentity(
      {
        provider: "github",
        subject: "1001",
        email: "owner@mgpt.mn",
      },
      { transaction },
    );

    expect(result).toEqual({ accountID: "acc_existing", newAccount: false });
    expect(sqlite.query("select count(*) as count from account").get()).toEqual(
      { count: 1 },
    );
    expect(
      sqlite
        .query(
          "select provider, account_id, time_deleted from auth order by provider",
        )
        .all(),
    ).toEqual([
      { provider: "email", account_id: "acc_existing", time_deleted: null },
      { provider: "github", account_id: "acc_existing", time_deleted: null },
    ]);
  });

  test("reactivates soft-deleted identities without creating an orphan account", async () => {
    const { sqlite, transaction } = await fixture();
    sqlite
      .query(
        "insert into auth (id, provider, subject, account_id, time_deleted) values (?, 'github', ?, ?, ?)",
      )
      .run("auth_deleted_github", "1001", "acc_deleted", 1);
    sqlite
      .query(
        "insert into auth (id, provider, subject, account_id, time_deleted) values (?, 'email', ?, ?, ?)",
      )
      .run("auth_deleted_email", "owner@mgpt.mn", "acc_deleted", 1);

    const result = await provisionOAuthAccountIdentity(
      {
        provider: "github",
        subject: "1001",
        email: "owner@mgpt.mn",
      },
      { transaction },
    );

    expect(result.newAccount).toBe(true);
    expect(sqlite.query("select count(*) as count from account").get()).toEqual(
      { count: 1 },
    );
    expect(
      sqlite
        .query(
          "select count(*) as count from auth where account_id not in (select id from account)",
        )
        .get(),
    ).toEqual({
      count: 0,
    });
    expect(
      sqlite
        .query(
          "select count(*) as count from auth where time_deleted is not null",
        )
        .get(),
    ).toEqual({
      count: 0,
    });
  });

  test("fails closed when active provider and email identities point at different accounts", async () => {
    const { sqlite, transaction } = await fixture();
    sqlite.query("insert into account (id) values (?)").run("acc_provider");
    sqlite.query("insert into account (id) values (?)").run("acc_email");
    sqlite
      .query(
        "insert into auth (id, provider, subject, account_id) values (?, 'github', ?, ?)",
      )
      .run("auth_provider", "1001", "acc_provider");
    sqlite
      .query(
        "insert into auth (id, provider, subject, account_id) values (?, 'email', ?, ?)",
      )
      .run("auth_email", "owner@mgpt.mn", "acc_email");

    let failure: unknown;
    try {
      await provisionOAuthAccountIdentity(
        {
          provider: "github",
          subject: "1001",
          email: "owner@mgpt.mn",
        },
        { transaction },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(OAuthIdentityConflictError);

    expect(sqlite.query("select count(*) as count from account").get()).toEqual(
      { count: 2 },
    );
    expect(sqlite.query("select count(*) as count from auth").get()).toEqual({
      count: 2,
    });
  });
});
