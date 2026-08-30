import { Title } from "@solidjs/meta"
import { createAsync, query } from "@solidjs/router"
import { Show } from "solid-js"
import { and, count, Database, desc, eq, inArray, isNull } from "@mongolgpt/console-core/drizzle/index.js"
import { hasPlatformAdminPermission } from "@mongolgpt/console-core/platform-admin.js"
import { AccountTable } from "@mongolgpt/console-core/schema/account.sql.js"
import { AdminAuditLogTable, PlatformAdminTable } from "@mongolgpt/console-core/schema/admin.sql.js"
import { PaymentInvoiceTable, PlanSubscriptionTable } from "@mongolgpt/console-core/schema/billing.sql.js"
import { UserTable } from "@mongolgpt/console-core/schema/user.sql.js"
import { WorkspaceTable } from "@mongolgpt/console-core/schema/workspace.sql.js"
import { AdminOverviewView } from "~/component/admin-overview"
import { getPlatformAdminContext } from "~/lib/admin-context"
import { requirePlatformAdminPermission } from "~/lib/admin-auth"
import { getSystemReadiness } from "~/lib/system-readiness"
import { getAdminProviderHealth } from "~/lib/admin-provider-health.server"

async function getAdminOverview() {
  "use server"
  const admin = requirePlatformAdminPermission(getPlatformAdminContext(), "overview.read")

  const [overview, readiness, providerHealth] = await Promise.all([
    Database.use(async (tx) => {
      const metrics = await Promise.all([
        tx.select({ value: count() }).from(AccountTable).where(isNull(AccountTable.timeDeleted)),
        tx.select({ value: count() }).from(UserTable).where(isNull(UserTable.timeDeleted)),
        tx.select({ value: count() }).from(WorkspaceTable).where(isNull(WorkspaceTable.timeDeleted)),
        tx
          .select({ value: count() })
          .from(PlanSubscriptionTable)
          .where(and(eq(PlanSubscriptionTable.status, "active"), isNull(PlanSubscriptionTable.timeDeleted))),
        tx
          .select({ value: count() })
          .from(PaymentInvoiceTable)
          .where(
            and(inArray(PaymentInvoiceTable.status, ["created", "pending"]), isNull(PaymentInvoiceTable.timeDeleted)),
          ),
        tx
          .select({ value: count() })
          .from(PlatformAdminTable)
          .where(and(eq(PlatformAdminTable.status, "active"), isNull(PlatformAdminTable.timeDeleted))),
      ])
      const audit = hasPlatformAdminPermission(admin.role, "audit.read")
        ? await tx
            .select({
              id: AdminAuditLogTable.id,
              actor: AdminAuditLogTable.actor_email,
              action: AdminAuditLogTable.action,
              target: AdminAuditLogTable.target_id,
              outcome: AdminAuditLogTable.outcome,
              time: AdminAuditLogTable.time_created,
            })
            .from(AdminAuditLogTable)
            .orderBy(desc(AdminAuditLogTable.time_created))
            .limit(12)
        : []

      return {
        admin,
        metrics: {
          accounts: metricValue(metrics[0]),
          users: metricValue(metrics[1]),
          workspaces: metricValue(metrics[2]),
          subscriptions: metricValue(metrics[3]),
          pendingPayments: metricValue(metrics[4]),
          administrators: metricValue(metrics[5]),
        },
        audit: audit.map((entry) => ({
          ...entry,
          time: entry.time.toISOString(),
        })),
        auditVisible: hasPlatformAdminPermission(admin.role, "audit.read"),
        generatedAt: new Date().toISOString(),
      }
    }),
    getSystemReadiness(),
    getAdminProviderHealth(),
  ])
  return { ...overview, readiness, providerHealth }
}

const overviewQuery = query(getAdminOverview, "admin.overview")

export default function AdminOverviewPage() {
  const overview = createAsync(() => overviewQuery())

  return (
    <>
      <Title>MongolGPT удирдлага</Title>
      <Show
        when={overview()}
        fallback={
          <main data-page="admin-overview">
            <section data-component="loading" aria-live="polite">
              Удирдлагын мэдээллийг ачаалж байна...
            </section>
          </main>
        }
      >
        {(data) => <AdminOverviewView data={data()} />}
      </Show>
    </>
  )
}

function metricValue(rows: { value: number }[] | undefined) {
  return rows?.[0]?.value ?? 0
}
