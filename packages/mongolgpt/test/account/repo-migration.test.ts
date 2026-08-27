import { expect, test } from "bun:test"
import path from "node:path"
import { Context, Effect, Exit, Layer, Option } from "effect"
import { eq } from "drizzle-orm"

import { AccountRepo } from "../../src/account/repo"
import { AccessToken, AccountID, RefreshToken } from "../../src/account/schema"
import { createAccountTokenCodec } from "../../src/account/token-codec"
import { AccountTable } from "@mongolgpt/core/account/sql"
import { Database } from "@mongolgpt/core/database/database"
import { tmpdir } from "../fixture/fixture"

const codec = createAccountTokenCodec(new Uint8Array(32).fill(29))

function account(id: string, accessToken: string, refreshToken: string) {
  return {
    id: AccountID.make(id),
    email: `${id}@example.com`,
    url: "https://account.example.com",
    access_token: AccessToken.make(accessToken),
    refresh_token: RefreshToken.make(refreshToken),
    token_expiry: Date.now() + 60_000,
  }
}

test("atomically migrates existing plaintext account tokens", async () => {
  await using tmp = await tmpdir()
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const databaseContext = yield* Layer.build(Database.layerFromPath(path.join(tmp.path, "account.sqlite")))
        const database = Context.get(databaseContext, Database.Service)
        yield* database.db
          .insert(AccountTable)
          .values(account("legacy", "legacy-access", "legacy-refresh"))
          .run()

        const repositoryContext = yield* Layer.build(
          AccountRepo.layerWithTokenCodec(codec).pipe(Layer.provide(Layer.succeed(Database.Service, database))),
        )
        const repository = Context.get(repositoryContext, AccountRepo.Service)
        const stored = yield* database.db
          .select()
          .from(AccountTable)
          .where(eq(AccountTable.id, AccountID.make("legacy")))
          .get()

        expect(stored?.access_token).toStartWith("mgpt:v1:")
        expect(stored?.refresh_token).toStartWith("mgpt:v1:")
        expect(stored?.access_token).not.toContain("legacy-access")
        expect(stored?.refresh_token).not.toContain("legacy-refresh")

        const decoded = Option.getOrThrow(yield* repository.getRow(AccountID.make("legacy")))
        expect(decoded.access_token).toBe(AccessToken.make("legacy-access"))
        expect(decoded.refresh_token).toBe(RefreshToken.make("legacy-refresh"))
      }),
    ),
  )
})

test("migrates plaintext while keeping a corrupt encrypted account removable", async () => {
  await using tmp = await tmpdir()
  const encrypted = codec.protect("corrupt-access")
  const [nonce, tag, encodedCiphertext] = encrypted.slice("mgpt:v1:".length).split(":")
  const ciphertext = Buffer.from(encodedCiphertext, "base64url")
  ciphertext[0] = ciphertext[0] ^ 1
  const corrupt = `mgpt:v1:${nonce}:${tag}:${ciphertext.toString("base64url")}`
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const databaseContext = yield* Layer.build(Database.layerFromPath(path.join(tmp.path, "account.sqlite")))
        const database = Context.get(databaseContext, Database.Service)
        yield* database.db
          .insert(AccountTable)
          .values([
            account("plaintext", "plain-access", "plain-refresh"),
            account("prefixed", "mgpt:v1:legacy-access", "mgpt:v1:legacy-refresh"),
            account("corrupt", corrupt, corrupt),
          ])
          .run()

        const repositoryContext = yield* Layer.build(
          AccountRepo.layerWithTokenCodec(codec).pipe(Layer.provide(Layer.succeed(Database.Service, database))),
        )
        const repository = Context.get(repositoryContext, AccountRepo.Service)

        const plaintext = yield* database.db
          .select()
          .from(AccountTable)
          .where(eq(AccountTable.id, AccountID.make("plaintext")))
          .get()
        expect(plaintext?.access_token).toStartWith("mgpt:v1:")
        expect(plaintext?.refresh_token).toStartWith("mgpt:v1:")

        const prefixed = Option.getOrThrow(yield* repository.getRow(AccountID.make("prefixed")))
        expect(prefixed.access_token).toBe(AccessToken.make("mgpt:v1:legacy-access"))
        expect(prefixed.refresh_token).toBe(RefreshToken.make("mgpt:v1:legacy-refresh"))

        const corruptRead = yield* Effect.exit(repository.getRow(AccountID.make("corrupt")))
        expect(Exit.isFailure(corruptRead)).toBe(true)
        expect((yield* repository.list()).map((item) => item.id)).toContain(AccountID.make("corrupt"))

        yield* repository.remove(AccountID.make("corrupt"))
        expect((yield* repository.list()).map((item) => item.id)).not.toContain(AccountID.make("corrupt"))
      }),
    ),
  )
})
