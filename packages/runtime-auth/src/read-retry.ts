export const runtimeReadRetryHeader = "x-mongolgpt-runtime-read-retry"

export function isRuntimeReadRetryScope(value: string | null): value is string {
  return value !== null && /^v1\.[a-f0-9]{64}$/.test(value)
}

// This binds a read retry to its original identity; it is NOT an authentication credential.
// The server must authenticate the new request independently before comparing this value.
export async function runtimeReadRetryScope(input: { accountID: string; workspaceID: string; authVersion: number }) {
  const value = JSON.stringify([
    "mongolgpt-runtime-read-retry-v1",
    input.accountID,
    input.workspaceID,
    input.authVersion,
  ])
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return `v1.${Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("")}`
}
