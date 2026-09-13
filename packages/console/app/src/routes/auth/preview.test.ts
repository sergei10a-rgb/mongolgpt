import { expect, test } from "bun:test"
import { hostedPreviewReturn } from "../../lib/hosted-preview"

test("preview continuation is fixed, non-cacheable and owner-only", () => {
  const anonymous = hostedPreviewReturn(undefined)
  expect(anonymous.status).toBe(302)
  expect(anonymous.headers.get("Location")).toBe("https://dev.mgpt.mn/auth/authorize?continue=/auth/preview")
  const owner = hostedPreviewReturn("sergei10a@gmail.com")
  expect(owner.status).toBe(302)
  expect(owner.headers.get("Location")).toBe("https://preview.dev.mgpt.mn/")
  expect(owner.headers.get("Cache-Control")).toBe("no-store")
  const other = hostedPreviewReturn("other@example.com")
  expect(other.status).toBe(403)
  expect(other.headers.get("Location")).toBeNull()
})
