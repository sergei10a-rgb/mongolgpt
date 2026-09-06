import { describe, expect, test } from "bun:test"
import { canDisposeDirectory, pickDirectoriesToEvict } from "./global-sync/eviction"
import { estimateRootSessionTotal, loadRootSessionsWithFallback } from "./global-sync/session-load"
import {
  hasRuntimeFilesystem,
  isProviderQuery,
  isProviderRefreshEvent,
  isRuntimePath,
  runtimePathStatus,
} from "./server-sync"
import { ServerScope } from "@/utils/server-scope"

describe("isProviderRefreshEvent", () => {
  test("refreshes legacy provider queries for the models.dev event", () => {
    expect(isProviderRefreshEvent({ type: "models-dev.refreshed" })).toBe(true)
    expect(isProviderRefreshEvent({ type: "catalog.updated" })).toBe(false)
  })
})

describe("isProviderQuery", () => {
  test("matches global and directory provider resources", () => {
    expect(isProviderQuery([ServerScope.local, null, "providers"], ServerScope.local)).toBe(true)
    expect(isProviderQuery([ServerScope.local, "C:/repo", "providers"], ServerScope.local)).toBe(true)
    expect(isProviderQuery(["remote" as ServerScope, null, "providers"], ServerScope.local)).toBe(false)
    expect(isProviderQuery([ServerScope.local, null, "models"], ServerScope.local)).toBe(false)
  })
})

describe("hasRuntimeFilesystem", () => {
  const path = { state: "", config: "", worktree: "", directory: "", home: "" }

  test("fails closed until the runtime exposes a filesystem root", () => {
    expect(hasRuntimeFilesystem(path)).toBe(false)
  })

  test("accepts either a home or active directory", () => {
    expect(hasRuntimeFilesystem({ ...path, home: "/workspace" })).toBe(true)
    expect(hasRuntimeFilesystem({ ...path, directory: "/workspace/repo" })).toBe(true)
  })
})

describe("runtimePathStatus", () => {
  test("reports loading while the path query is fetching", () => {
    expect(runtimePathStatus({ isPending: false, isFetching: true, isError: false, hasData: true })).toBe("loading")
  })

  test("reports an error after the path query fails", () => {
    expect(runtimePathStatus({ isPending: false, isFetching: false, isError: true, hasData: false })).toBe("error")
  })

  test("reports ready for a successful empty path response", () => {
    expect(runtimePathStatus({ isPending: false, isFetching: false, isError: false, hasData: true })).toBe("ready")
  })

  test("does not claim ready for missing settled data or a pending offline query", () => {
    expect(runtimePathStatus({ isPending: false, isFetching: false, isError: false, hasData: false })).toBe("error")
    expect(runtimePathStatus({ isPending: true, isFetching: false, isError: false, hasData: false })).toBe("loading")
  })
})

describe("isRuntimePath", () => {
  test("accepts a valid empty hosted path response", () => {
    expect(isRuntimePath({ home: "", state: "", config: "", worktree: "", directory: "" })).toBe(true)
  })

  test("rejects malformed hosted path responses", () => {
    expect(isRuntimePath({ home: "/workspace", directory: "/workspace" })).toBe(false)
    expect(isRuntimePath(null)).toBe(false)
    expect(isRuntimePath("<!doctype html><title>not an API</title>")).toBe(false)
    expect(isRuntimePath([])).toBe(false)
    expect(isRuntimePath({ home: {}, state: "", config: "", worktree: "", directory: "" })).toBe(false)
  })
})

describe("pickDirectoriesToEvict", () => {
  test("keeps pinned stores and evicts idle stores", () => {
    const now = 5_000
    const picks = pickDirectoriesToEvict({
      stores: ["a", "b", "c", "d"],
      state: new Map([
        ["a", { lastAccessAt: 1_000 }],
        ["b", { lastAccessAt: 4_900 }],
        ["c", { lastAccessAt: 4_800 }],
        ["d", { lastAccessAt: 3_000 }],
      ]),
      pins: new Set(["a"]),
      max: 2,
      ttl: 1_500,
      now,
    })

    expect(picks).toEqual(["d", "c"])
  })
})

describe("loadRootSessionsWithFallback", () => {
  test("uses limited roots query when supported", async () => {
    const calls: Array<{ directory: string; roots: true; limit?: number }> = []

    const result = await loadRootSessionsWithFallback({
      directory: "dir",
      limit: 10,
      list: async (query) => {
        calls.push(query)
        return { data: [] }
      },
    })

    expect(result.data).toEqual([])
    expect(result.limited).toBe(true)
    expect(calls).toEqual([{ directory: "dir", roots: true, limit: 10 }])
  })

  test("falls back to full roots query on limited-query failure", async () => {
    const calls: Array<{ directory: string; roots: true; limit?: number }> = []

    const result = await loadRootSessionsWithFallback({
      directory: "dir",
      limit: 25,
      list: async (query) => {
        calls.push(query)
        if (query.limit) throw new Error("unsupported")
        return { data: [] }
      },
    })

    expect(result.data).toEqual([])
    expect(result.limited).toBe(false)
    expect(calls).toEqual([
      { directory: "dir", roots: true, limit: 25 },
      { directory: "dir", roots: true },
    ])
  })
})

describe("estimateRootSessionTotal", () => {
  test("keeps exact total for full fetches", () => {
    expect(estimateRootSessionTotal({ count: 42, limit: 10, limited: false })).toBe(42)
  })

  test("marks has-more for full-limit limited fetches", () => {
    expect(estimateRootSessionTotal({ count: 10, limit: 10, limited: true })).toBe(11)
  })

  test("keeps exact total when limited fetch is under limit", () => {
    expect(estimateRootSessionTotal({ count: 9, limit: 10, limited: true })).toBe(9)
  })
})

describe("canDisposeDirectory", () => {
  test("rejects pinned or inflight directories", () => {
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: true,
        booting: false,
        loadingSessions: false,
      }),
    ).toBe(false)
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: false,
        booting: true,
        loadingSessions: false,
      }),
    ).toBe(false)
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: false,
        booting: false,
        loadingSessions: true,
      }),
    ).toBe(false)
  })

  test("accepts idle unpinned directory store", () => {
    expect(
      canDisposeDirectory({
        directory: "dir",
        hasStore: true,
        pinned: false,
        booting: false,
        loadingSessions: false,
      }),
    ).toBe(true)
  })
})
