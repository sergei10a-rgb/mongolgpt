import { parseAdminAccessConfig, verifyCloudflareAccessAssertion } from "../../../admin/src/lib/access"

export default {
  async fetch(request: Request) {
    try {
      const identity = await verifyCloudflareAccessAssertion(
        request.headers.get("cf-access-jwt-assertion") ?? "",
        parseAdminAccessConfig({
          teamDomain: "https://synthetic.cloudflareaccess.com",
          audience: "synthetic-admin-audience",
          bootstrapEmails: "owner@example.test",
        }),
      )
      return Response.json(identity)
    } catch {
      return Response.json({ error: "denied" }, { status: 403 })
    }
  },
}
