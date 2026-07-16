import openapi from "../../../../sdk/openapi.json?raw"

export function GET() {
  return new Response(openapi, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  })
}
