import { drizzle } from "drizzle-orm/d1"
import { Resource } from "@mongolgpt/console-resource"
export * from "drizzle-orm"
import type { SQLiteTransactionConfig } from "drizzle-orm/sqlite-core"
import { Context } from "../context"
import { memo } from "../util/memo"
import * as schema from "../schema-d1"

export namespace Database {
  const client = memo(() => {
    return drizzle(Resource.Database, { schema })
  })

  type Client = ReturnType<typeof client>
  export type Transaction = Parameters<Parameters<Client["transaction"]>[0]>[0]
  export type TxOrDb = Transaction | ReturnType<typeof client>

  const TransactionContext = Context.create<{
    tx: TxOrDb
    effects: (() => void | Promise<void>)[]
  }>()

  export async function use<T>(callback: (trx: TxOrDb) => Promise<T>) {
    try {
      const { tx } = TransactionContext.use()
      return tx.transaction(callback)
    } catch (err) {
      if (err instanceof Context.NotFound) {
        const effects: (() => void | Promise<void>)[] = []
        const result = await TransactionContext.provide(
          {
            effects,
            tx: client(),
          },
          () => callback(client()),
        )
        await Promise.all(effects.map((x) => x()))
        return result
      }
      throw err
    }
  }
  export async function fn<Input, T>(callback: (input: Input, trx: TxOrDb) => Promise<T>) {
    return (input: Input) => use(async (tx) => callback(input, tx))
  }

  export async function effect(effect: () => any | Promise<any>) {
    try {
      const { effects } = TransactionContext.use()
      effects.push(effect)
    } catch {
      await effect()
    }
  }

  export async function transaction<T>(callback: (tx: TxOrDb) => Promise<T>, config?: SQLiteTransactionConfig) {
    try {
      const { tx } = TransactionContext.use()
      return callback(tx)
    } catch (err) {
      if (err instanceof Context.NotFound) {
        const effects: (() => void | Promise<void>)[] = []
        const result = await client().transaction(async (tx) => {
          return TransactionContext.provide({ tx, effects }, () => callback(tx))
        }, config)
        await Promise.all(effects.map((x) => x()))
        return result
      }
      throw err
    }
  }
}
