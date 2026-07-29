export class AdminMutationRequestError extends Error {
  constructor(readonly code: "method" | "origin" | "fetch_site" | "content_type") {
    super(code)
    this.name = "AdminMutationRequestError"
  }
}

export function requireSameOriginAdminMutation(request: Request) {
  if (request.method.toUpperCase() !== "POST") throw new AdminMutationRequestError("method")

  const origin = request.headers.get("origin")
  if (!origin) throw new AdminMutationRequestError("origin")
  try {
    if (new URL(origin).origin !== new URL(request.url).origin) {
      throw new AdminMutationRequestError("origin")
    }
  } catch (error) {
    if (error instanceof AdminMutationRequestError) throw error
    throw new AdminMutationRequestError("origin")
  }

  const fetchSite = request.headers.get("sec-fetch-site")
  if (fetchSite && fetchSite !== "same-origin") {
    throw new AdminMutationRequestError("fetch_site")
  }

  const contentType = request.headers.get("content-type")?.toLowerCase() ?? ""
  if (!contentType.startsWith("multipart/form-data") && !contentType.startsWith("application/x-www-form-urlencoded")) {
    throw new AdminMutationRequestError("content_type")
  }
}
