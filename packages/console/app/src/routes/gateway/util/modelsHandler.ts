export async function buildOptionsResponse() {
  return new Response(null, {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Org-ID",
      "Cache-Control": "no-store",
    },
  })
}

interface ModelsRequestDependencies {
  authenticate: (request: Request, token: string) => Promise<string | undefined>
  disabled: (workspaceID: string) => Promise<readonly string[]>
  models: () => readonly string[]
}

export async function buildAuthenticatedModelsResponse(request: Request, dependencies: ModelsRequestDependencies) {
  const authorization = request.headers.get("authorization")
  const token = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1]
  if (!token) return buildModelsUnauthorizedResponse()

  const workspaceID = await dependencies.authenticate(request, token)
  if (!workspaceID) return buildModelsUnauthorizedResponse()

  const disabled = await dependencies.disabled(workspaceID)
  const models = dependencies
    .models()
    .filter((id) => !id.endsWith(":global"))
    .filter((id) => !disabled.includes(id))
  return buildModelsResponse(models)
}

export function buildModelsUnauthorizedResponse() {
  return Response.json(
    {
      error: {
        type: "authentication_error",
        message: "MongolGPT нэвтрэх эрх буруу эсвэл хүчингүй болсон байна.",
      },
    },
    {
      status: 401,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      },
    },
  )
}

export async function buildModelsResponse(models: string[]) {
  return new Response(
    JSON.stringify({
      object: "list",
      data: models
        .filter((id) => !id.startsWith("alpha-"))
        .map((id) => ({
          id,
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "mongolgpt",
        })),
    }),
    {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
        "Content-Type": "application/json",
      },
    },
  )
}
