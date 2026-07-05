import type { APIEvent } from "@solidjs/start/server"

export async function POST(_event: APIEvent) {
  return Response.json(
    {
      error: "unsupported_grant_type",
      error_description:
        "MongolGPT CLI browser OAuth ашигладаг болсон. Шинэчилсний дараа `mongolgpt console login` дахин ажиллуулна уу.",
    },
    { status: 400, headers: { "Cache-Control": "no-store" } },
  )
}
