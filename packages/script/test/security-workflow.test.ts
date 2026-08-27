import { describe, expect, test } from "bun:test"

const CHECKOUT_SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1"
const GITLEAKS_SHA = "e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e"
const OSV_SHA = "6e4298ebc4db23e847df9b2e2de2939d6f066c67"

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

describe("supply-chain security workflow", () => {
  test("scans committed secrets and Bun dependencies with pinned actions", async () => {
    const source = await Bun.file(new URL("../../../.github/workflows/security.yml", import.meta.url)).text()
    const parsed: unknown = Bun.YAML.parse(source)

    expect(record(parsed)).toBe(true)
    if (!record(parsed)) return
    expect(parsed.permissions).toEqual({ contents: "read" })
    expect(source).toContain(`actions/checkout@${CHECKOUT_SHA}`)
    expect(source).toContain(`gitleaks/gitleaks-action@${GITLEAKS_SHA}`)
    expect(source).toContain(`google/osv-scanner-action/.github/workflows/osv-scanner-reusable.yml@${OSV_SHA}`)
    expect(source).toContain(`google/osv-scanner-action/.github/workflows/osv-scanner-reusable-pr.yml@${OSV_SHA}`)
    expect(source).toContain("fetch-depth: 0")
    expect(source).toContain("persist-credentials: false")
    expect(source).toContain("if: github.event_name == 'push' || github.event_name == 'pull_request'")
    expect(source).toContain("--recursive")
    expect(source).not.toMatch(/uses:\s+[^\s]+@(main|master|v\d+(?:\.\d+)*)\b/)
  })

  test("keeps vulnerability reporting permissions scoped to OSV jobs", async () => {
    const source = await Bun.file(new URL("../../../.github/workflows/security.yml", import.meta.url)).text()
    const parsed: unknown = Bun.YAML.parse(source)
    if (!record(parsed) || !record(parsed.jobs)) throw new Error("Security workflow jobs are missing")

    const secretScan = parsed.jobs["secret-scan"]
    const dependencyScan = parsed.jobs["dependency-scan"]
    const dependencyPrScan = parsed.jobs["dependency-pr-scan"]
    if (!record(secretScan) || !record(dependencyScan) || !record(dependencyPrScan)) {
      throw new Error("Security workflow scan jobs are missing")
    }

    expect(secretScan.permissions).toBeUndefined()
    expect(dependencyScan.permissions).toEqual({
      actions: "read",
      contents: "read",
      "security-events": "write",
    })
    expect(dependencyScan.with).toEqual({
      "fail-on-vuln": false,
      "scan-args": "--include-git-root\n--recursive\n./",
    })
    expect(dependencyPrScan.permissions).toEqual(dependencyScan.permissions)
    expect(dependencyPrScan.with).toEqual({
      "scan-args": "--include-git-root\n--recursive\n./",
    })
  })
})
