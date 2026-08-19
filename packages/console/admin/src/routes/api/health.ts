import type { APIEvent } from "@solidjs/start/server"
import { hasPlatformAdminPermission } from "@mongolgpt/console-core/platform-admin.js"
import { platformAdminFromLocals } from "~/lib/admin-context"
import { getSystemReadiness } from "~/lib/system-readiness"

export async function GET(event: APIEvent) {
  const admin = platformAdminFromLocals(event.locals)
  if (!admin || !hasPlatformAdminPermission(admin.role, "system.read")) {
    return Response.json(
      {
        error: "admin_permission_denied",
        message: "Системийн төлөв харах эрх хүрэлцэхгүй байна.",
      },
      {
        status: 403,
        headers: {
          "Cache-Control": "no-store",
        },
      },
    )
  }
  const readiness = await getSystemReadiness()
  return Response.json(
    { service: "mongolgpt-admin", requestID: admin.requestID, ...readiness },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  )
}
