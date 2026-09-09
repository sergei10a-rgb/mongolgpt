import { expect, test } from "bun:test"
import { StartupHandoff } from "@mongolgpt/core/database/startup-handoff"

const name = "mongolgpt-00000000-0000-4000-8000-000000000001"
const group = `/sys/fs/cgroup/${name}`
const base = "10 1 0:20 / /sys/fs/cgroup rw,nosuid - cgroup2 cgroup rw\n"

test("startup maps mount roots to exact namespace membership", () => {
  expect(StartupHandoff.cgroupMembership(group, base)).toBe(`/${name}`)
  expect(
    StartupHandoff.cgroupMembership(group, `${base}11 10 0:20 /container /sys/fs/cgroup rw - cgroup2 cgroup rw\n`),
  ).toBe(`/container/${name}`)
  expect(
    StartupHandoff.cgroupMembership(group, `${base}11 10 0:20 /../outside /sys/fs/cgroup rw - cgroup2 cgroup rw\n`),
  ).toBe(`/../outside/${name}`)
  expect(
    StartupHandoff.cgroupMembership(
      `/sys/fs/cgroup/nested/${name}`,
      `${base}11 10 0:20 /other /sys/fs/cgroup/nested rw master:3 - cgroup2 cgroup rw\n`,
    ),
  ).toBe(`/other/${name}`)
})

test("startup rejects ambiguous, malformed, non-cgroup or unrelated mounts", () => {
  for (const mounts of [
    "",
    "malformed",
    base.replace("cgroup2", "tmpfs"),
    base.replace("/sys/fs/cgroup", "/sys/fs/cgroup-other"),
    `${base}11 1 0:20 /other /sys/fs/cgroup rw - cgroup2 cgroup rw\n`,
    `${base}11 10 0:21 / /sys/fs/cgroup rw - tmpfs tmpfs rw\n`,
    base.replace("/ /sys", "/invalid\\040root /sys"),
    "a".repeat(1024 * 1024 + 1),
  ])
    expect(() => StartupHandoff.cgroupMembership(group, mounts)).toThrow(StartupHandoff.HandoffError)
  expect(() => StartupHandoff.cgroupMembership(`/sys/fs/cgroup/../${name}`, base)).toThrow(StartupHandoff.HandoffError)
})

test("handoff identity rejection retains a safe reason without exposing packet details", async () => {
  const error = await StartupHandoff.accept("/private-workspace").catch((error: unknown) => error)
  expect(error).toBeInstanceOf(StartupHandoff.HandoffError)
  expect(Object.getOwnPropertyDescriptor(error, "code")?.value).toBe("handoff_identity")
  expect((error as Error).message).toBe(new StartupHandoff.HandoffError().message)
  expect((error as Error).message).not.toContain("private-workspace")
})
