import { z } from "zod"
import { ulid } from "ulid"
import { and, desc, eq, Database } from "./drizzle"
import { PlanConfigActiveTable, PlanConfigVersionTable } from "./schema/plan-config.sql"
import { Subscription } from "./subscription"

type Limits = z.output<typeof Subscription.LimitsSchema>
const StoredLimitsSchemaValue = Subscription.LimitsSchema.omit({ free: true })
  .extend({
    free: Subscription.LimitsSchema.shape.free.omit({ checkHeaders: true }).strict(),
  })
  .strict()
type StoredLimits = z.output<typeof StoredLimitsSchemaValue>

const VersionInputSchema = z
  .object({
    limits: StoredLimitsSchemaValue,
    createdBy: z.string().trim().min(1).max(30),
    sourceVersionID: z.string().trim().min(1).max(30).optional(),
    note: z.string().trim().min(1).max(500).optional(),
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict()

const ActivationInputSchema = z
  .object({
    versionID: z.string().trim().min(1).max(30),
    updatedBy: z.string().trim().min(1).max(30),
    expectedStateRevision: z.number().int().nonnegative().nullable(),
  })
  .strict()

const RollbackInputSchema = z
  .object({
    sourceVersionID: z.string().trim().min(1).max(30),
    createdBy: z.string().trim().min(1).max(30),
    note: z.string().trim().min(1).max(500).optional(),
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict()

export class PlanConfigConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PlanConfigConflictError"
  }
}

export class PlanConfigInvalidActiveError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "PlanConfigInvalidActiveError"
  }
}

export namespace PlanConfig {
  export const StoredLimitsSchema = StoredLimitsSchemaValue

  export async function getRuntimeLimits(): Promise<Limits> {
    return Database.use((db) => getRuntimeLimitsWithDb(db))
  }

  /**
   * Uses bootstrap-only proxy verification headers with either the active numeric limits or the full bootstrap fallback.
   */
  export async function getRuntimeLimitsWithDb(db: Database.TxOrDb, bootstrap?: unknown): Promise<Limits> {
    const bootstrapLimits =
      bootstrap === undefined ? Subscription.getBootstrapLimits() : Subscription.LimitsSchema.parse(bootstrap)
    const active = await getActiveWithDb(db)
    if (!active) return bootstrapLimits
    return Subscription.LimitsSchema.parse({
      ...active.limits,
      free: {
        ...active.limits.free,
        checkHeaders: bootstrapLimits.free.checkHeaders,
      },
    })
  }

  export async function getActiveWithDb(db: Database.TxOrDb) {
    const state = await db
      .select()
      .from(PlanConfigActiveTable)
      .where(eq(PlanConfigActiveTable.id, 1))
      .limit(1)
      .then((rows) => rows[0])
    if (!state) return undefined

    const version = await db
      .select()
      .from(PlanConfigVersionTable)
      .where(eq(PlanConfigVersionTable.id, state.active_version_id))
      .limit(1)
      .then((rows) => rows[0])
    if (!version) {
      throw new PlanConfigInvalidActiveError(`Идэвхтэй төлөвлөгөөний хувилбар олдсонгүй: ${state.active_version_id}`)
    }

    return {
      state,
      version,
      limits: parseStoredLimits(version.limits, version.id),
    }
  }

  export async function createVersionWithDb(db: Database.TxOrDb, raw: z.input<typeof VersionInputSchema>) {
    return createVersionWithInput(db, VersionInputSchema.parse(raw))
  }

  /** Clones a historic version into the next immutable revision. Activation remains an explicit CAS step. */
  export async function cloneVersionForRollbackWithDb(db: Database.TxOrDb, raw: z.input<typeof RollbackInputSchema>) {
    const input = RollbackInputSchema.parse(raw)
    const source = await db
      .select()
      .from(PlanConfigVersionTable)
      .where(eq(PlanConfigVersionTable.id, input.sourceVersionID))
      .limit(1)
      .then((rows) => rows[0])
    if (!source)
      throw new PlanConfigInvalidActiveError(`Буцаах төлөвлөгөөний хувилбар олдсонгүй: ${input.sourceVersionID}`)
    return createVersionWithInput(
      db,
      VersionInputSchema.parse({
        limits: parseStoredLimits(source.limits, source.id),
        createdBy: input.createdBy,
        sourceVersionID: source.id,
        note: input.note,
        expectedRevision: input.expectedRevision,
      }),
      true,
    )
  }

  export async function activateVersionWithDb(db: Database.TxOrDb, raw: z.input<typeof ActivationInputSchema>) {
    const input = ActivationInputSchema.parse(raw)
    const version = await db
      .select({ id: PlanConfigVersionTable.id })
      .from(PlanConfigVersionTable)
      .where(eq(PlanConfigVersionTable.id, input.versionID))
      .limit(1)
      .then((rows) => rows[0])
    if (!version) throw new PlanConfigInvalidActiveError(`Төлөвлөгөөний хувилбар олдсонгүй: ${input.versionID}`)

    if (input.expectedStateRevision === null) {
      try {
        await db.insert(PlanConfigActiveTable).values({
          id: 1,
          active_version_id: version.id,
          revision: 1,
          updated_by: input.updatedBy,
          time_updated: new Date(),
        })
      } catch (error) {
        if (isSingletonConflict(error))
          throw new PlanConfigConflictError("Идэвхтэй төлөвлөгөө аль хэдийн өөрчлөгдсөн байна")
        throw error
      }
      return { activeVersionID: version.id, revision: 1 }
    }

    const update = await db
      .update(PlanConfigActiveTable)
      .set({
        active_version_id: version.id,
        revision: input.expectedStateRevision + 1,
        updated_by: input.updatedBy,
        time_updated: new Date(),
      })
      .where(and(eq(PlanConfigActiveTable.id, 1), eq(PlanConfigActiveTable.revision, input.expectedStateRevision)))
      .returning({ revision: PlanConfigActiveTable.revision })
    if (update.length !== 1) throw new PlanConfigConflictError("Идэвхтэй төлөвлөгөө өөрчлөгдсөн байна")
    return { activeVersionID: version.id, revision: input.expectedStateRevision + 1 }
  }
}

async function createVersionWithInput(
  db: Database.TxOrDb,
  input: z.output<typeof VersionInputSchema>,
  sourceVerified = false,
) {
  const latest = await db
    .select({ revision: PlanConfigVersionTable.revision })
    .from(PlanConfigVersionTable)
    .orderBy(desc(PlanConfigVersionTable.revision))
    .limit(1)
    .then((rows) => rows[0])
  const currentRevision = latest?.revision ?? 0
  if (currentRevision !== input.expectedRevision) {
    throw new PlanConfigConflictError(`Төлөвлөгөөний хувилбар өөрчлөгдсөн байна: ${currentRevision}`)
  }
  if (input.sourceVersionID && !sourceVerified) {
    const source = await db
      .select({ id: PlanConfigVersionTable.id })
      .from(PlanConfigVersionTable)
      .where(eq(PlanConfigVersionTable.id, input.sourceVersionID))
      .limit(1)
      .then((rows) => rows[0])
    if (!source) throw new PlanConfigInvalidActiveError(`Эх сурвалж хувилбар олдсонгүй: ${input.sourceVersionID}`)
  }

  const version = {
    id: ulid(),
    revision: currentRevision + 1,
    limits: JSON.stringify(input.limits),
    created_by: input.createdBy,
    source_version_id: input.sourceVersionID,
    note: input.note,
  }
  try {
    await db.insert(PlanConfigVersionTable).values(version)
  } catch (error) {
    if (isRevisionConflict(error)) {
      throw new PlanConfigConflictError("Төлөвлөгөөний хувилбар зэрэгцэн өөрчлөгдсөн байна")
    }
    throw error
  }
  return version
}

function parseStoredLimits(value: unknown, versionID: string): StoredLimits {
  try {
    const json = typeof value === "string" ? JSON.parse(value) : value
    return StoredLimitsSchemaValue.parse(json)
  } catch (error) {
    throw new PlanConfigInvalidActiveError(`Идэвхтэй төлөвлөгөөний JSON буруу байна: ${versionID}`, { cause: error })
  }
}

function isRevisionConflict(error: unknown) {
  return (
    error instanceof Error &&
    (error.message.includes("plan_config_version_revision") || error.message.includes("plan_config_version.revision"))
  )
}

function isSingletonConflict(error: unknown) {
  return (
    error instanceof Error &&
    (error.message.includes("plan_config_active.id") || error.message.includes("UNIQUE constraint failed"))
  )
}
