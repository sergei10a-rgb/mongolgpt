export async function GET() {
  const response = await fetch("https://mongolgpt.duckdns.org/refs/heads/dev/packages/sdk/openapi.json")
  const json = await response.json()
  return json
}
