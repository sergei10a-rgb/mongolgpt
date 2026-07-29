import type { APIEvent } from "@solidjs/start/server"
import { hasPlatformAdminPermission } from "@mongolgpt/console-core/platform-admin.js"
import { platformAdminFromLocals } from "~/lib/admin-context"

export function GET(event: APIEvent) {
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
  return Response.json(
    {
      status: "ok",
      service: "mongolgpt-admin",
      requestID: admin.requestID,
    },
    {
      headers: {
        "Cache-Control": "no-store",
      },
    },
  )
}
