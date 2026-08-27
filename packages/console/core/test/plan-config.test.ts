import { describe, expect, test } from "bun:test"
import { Database as SQLite } from "bun:sqlite"
import { drizzle, type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import { resolve } from "node:path"
import { PlanConfig, PlanConfigConflictError, PlanConfigInvalidActiveError } from "../src/plan-config"
import { Database } from "../src/drizzle"
import * as schema from "../src/schema-d1"

const limits = {
  free: { promoTokens: 0, dailyRequests: 20, dailyRequestsFallback: 5, checkHeaders: { "x-proxy": "trusted" } },
  lite: { rollingLimit: 1, rollingWindow: 5, weeklyLimit: 5, monthlyLimit: 10 },
  plans: {
    basic: {
      weeklyCostLimit: 1,
      weeklyTokenLimit: 100,
      weeklyRequestLimit: 10,
      monthlyCostLimit: 4,
      monthlyTokenLimit: 400,
      monthlyRequestLimit: 40,
      rollingCostLimit: 1,
      rollingWindow: 5,
    },
    pro: {
      weeklyCostLimit: 2,
      weeklyTokenLimit: 200,
      weeklyRequestLimit: 20,
      monthlyCostLimit: 8,
      monthlyTokenLimit: 800,
      monthlyRequestLimit: 80,
      rollingCostLimit: 2,
      rollingWindow: 5,
    },
    max: {
      weeklyCostLimit: 3,
      weeklyTokenLimit: 300,
      weeklyRequestLimit: 30,
      monthlyCostLimit: 12,
      monthlyTokenLimit: 1200,
      monthlyRequestLimit: 120,
      rollingCostLimit: 3,
      rollingWindow: 5,
    },
  },
}

function toStoredLimits(value = limits) {
  const { checkHeaders: _checkHeaders, ...free } = value.free
  return { ...value, free }
}

async function fixture() {
  const sqlite = new SQLite(":memory:")
  const directory = resolve(import.meta.dir, "../migrations-d1")
  const paths: string[] = []
  for await (const path of new Bun.Glob("*/migration.sql").scan({ cwd: directory, absolute: true })) paths.push(path)
  sqlite.exec((await Promise.all(paths.sort().map((path) => Bun.file(path).text()))).join("\n"))
  const drizzleDb: SQLiteBunDatabase<typeof schema> = drizzle({ client: sqlite, schema })
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- Bun SQLite implements the D1 query subset
  return { sqlite, db: drizzleDb as unknown as Database.TxOrDb }
}

describe("PlanConfig", () => {
  test("uses the validated bootstrap limits while no active D1 row exists", async () => {
    const { db } = await fixture()
    await expect(PlanConfig.getRuntimeLimitsWithDb(db, limits)).resolves.toEqual(limits)
    await expect(PlanConfig.getRuntimeLimitsWithDb(db, {})).rejects.toBeDefined()
  })

  test("uses a valid active D1 version over the bootstrap fallback", async () => {
    const { db } = await fixture()
    const version = await PlanConfig.createVersionWithDb(db, {
      limits: toStoredLimits({ ...limits, free: { ...limits.free, promoTokens: 77 } }),
      createdBy: "adm_plan_config",
      expectedRevision: 0,
    })
    await PlanConfig.activateVersionWithDb(db, {
      versionID: version.id,
      updatedBy: "adm_plan_config",
      expectedStateRevision: null,
    })

    const active = await PlanConfig.getActiveWithDb(db)
    expect(active?.limits.free).not.toHaveProperty("checkHeaders")
    expect(active?.version.limits).not.toContain("x-proxy")
    await expect(PlanConfig.getRuntimeLimitsWithDb(db, limits)).resolves.toMatchObject({
      free: { promoTokens: 77, checkHeaders: limits.free.checkHeaders },
    })
    await expect(PlanConfig.getRuntimeLimitsWithDb(db, {})).rejects.toBeDefined()
    expect(PlanConfig.StoredLimitsSchema.safeParse(limits).success).toBe(false)
  })

  test("fails closed when the active version JSON does not satisfy the limits schema", async () => {
    const { sqlite, db } = await fixture()
    sqlite
      .query("insert into plan_config_version (id, revision, limits, created_by) values (?, ?, ?, ?)")
      .run("pcv_invalid", 1, "{}", "adm_plan_config")
    sqlite
      .query("insert into plan_config_active (id, active_version_id, revision, updated_by) values (?, ?, ?, ?)")
      .run(1, "pcv_invalid", 1, "adm_plan_config")

    await expect(PlanConfig.getRuntimeLimitsWithDb(db, limits)).rejects.toBeInstanceOf(PlanConfigInvalidActiveError)
  })

  test("creates monotonic immutable revisions and detects stale create requests", async () => {
    const { db } = await fixture()
    const first = await PlanConfig.createVersionWithDb(db, {
      limits: toStoredLimits(),
      createdBy: "adm_plan_config",
      expectedRevision: 0,
    })
    expect(first.revision).toBe(1)
    await expect(
      PlanConfig.createVersionWithDb(db, {
        limits: toStoredLimits(),
        createdBy: "adm_plan_config",
        expectedRevision: 0,
      }),
    ).rejects.toBeInstanceOf(PlanConfigConflictError)
    await expect(
      PlanConfig.createVersionWithDb(db, {
        limits: toStoredLimits(),
        createdBy: "adm_plan_config",
        sourceVersionID: "pcv_missing",
        expectedRevision: 1,
      }),
    ).rejects.toBeInstanceOf(PlanConfigInvalidActiveError)
  })

  test("clones a historic version for rollback and activates it with a state CAS", async () => {
    const { db } = await fixture()
    const first = await PlanConfig.createVersionWithDb(db, {
      limits: toStoredLimits(),
      createdBy: "adm_plan_config",
      expectedRevision: 0,
    })
    await PlanConfig.activateVersionWithDb(db, {
      versionID: first.id,
      updatedBy: "adm_plan_config",
      expectedStateRevision: null,
    })
    const second = await PlanConfig.createVersionWithDb(db, {
      limits: toStoredLimits({ ...limits, free: { ...limits.free, promoTokens: 99 } }),
      createdBy: "adm_plan_config",
      expectedRevision: 1,
    })
    await PlanConfig.activateVersionWithDb(db, {
      versionID: second.id,
      updatedBy: "adm_plan_config",
      expectedStateRevision: 1,
    })
    const rollback = await PlanConfig.cloneVersionForRollbackWithDb(db, {
      sourceVersionID: first.id,
      createdBy: "adm_plan_config",
      note: "rollback",
      expectedRevision: 2,
    })
    expect(rollback).toMatchObject({ revision: 3, source_version_id: first.id })
    await expect(
      PlanConfig.activateVersionWithDb(db, {
        versionID: rollback.id,
        updatedBy: "adm_plan_config",
        expectedStateRevision: 1,
      }),
    ).rejects.toBeInstanceOf(PlanConfigConflictError)
    await PlanConfig.activateVersionWithDb(db, {
      versionID: rollback.id,
      updatedBy: "adm_plan_config",
      expectedStateRevision: 2,
    })
    await expect(PlanConfig.getRuntimeLimitsWithDb(db, limits)).resolves.toEqual(limits)
  })
})
