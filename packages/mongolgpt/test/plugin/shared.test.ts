import { describe, expect, test } from "bun:test"
import { parsePluginSpecifier } from "../../src/plugin/shared"

describe("parsePluginSpecifier", () => {
  test("parses standard npm package without version", () => {
    expect(parsePluginSpecifier("acme")).toEqual({
      pkg: "acme",
      version: "latest",
    })
  })

  test("parses standard npm package with version", () => {
    expect(parsePluginSpecifier("acme@1.0.0")).toEqual({
      pkg: "acme",
      version: "1.0.0",
    })
  })

  test("parses scoped npm package without version", () => {
    expect(parsePluginSpecifier("@mongolgpt/acme")).toEqual({
      pkg: "@mongolgpt/acme",
      version: "latest",
    })
  })

  test("parses scoped npm package with version", () => {
    expect(parsePluginSpecifier("@mongolgpt/acme@1.0.0")).toEqual({
      pkg: "@mongolgpt/acme",
      version: "1.0.0",
    })
  })

  test("parses package with git+https url", () => {
    expect(parsePluginSpecifier("acme@git+https://github.com/mongolgpt/acme.git")).toEqual({
      pkg: "acme",
      version: "git+https://github.com/mongolgpt/acme.git",
    })
  })

  test("parses scoped package with git+https url", () => {
    expect(parsePluginSpecifier("@mongolgpt/acme@git+https://github.com/mongolgpt/acme.git")).toEqual({
      pkg: "@mongolgpt/acme",
      version: "git+https://github.com/mongolgpt/acme.git",
    })
  })

  test("parses package with git+ssh url containing another @", () => {
    expect(parsePluginSpecifier("acme@git+ssh://git@github.com/mongolgpt/acme.git")).toEqual({
      pkg: "acme",
      version: "git+ssh://git@github.com/mongolgpt/acme.git",
    })
  })

  test("parses scoped package with git+ssh url containing another @", () => {
    expect(parsePluginSpecifier("@mongolgpt/acme@git+ssh://git@github.com/mongolgpt/acme.git")).toEqual({
      pkg: "@mongolgpt/acme",
      version: "git+ssh://git@github.com/mongolgpt/acme.git",
    })
  })

  test("parses unaliased git+ssh url", () => {
    expect(parsePluginSpecifier("git+ssh://git@github.com/mongolgpt/acme.git")).toEqual({
      pkg: "git+ssh://git@github.com/mongolgpt/acme.git",
      version: "",
    })
  })

  test("parses npm alias using the alias name", () => {
    expect(parsePluginSpecifier("acme@npm:@mongolgpt/acme@1.0.0")).toEqual({
      pkg: "acme",
      version: "npm:@mongolgpt/acme@1.0.0",
    })
  })

  test("parses bare npm protocol specifier using the target package", () => {
    expect(parsePluginSpecifier("npm:@mongolgpt/acme@1.0.0")).toEqual({
      pkg: "@mongolgpt/acme",
      version: "1.0.0",
    })
  })

  test("parses unversioned npm protocol specifier", () => {
    expect(parsePluginSpecifier("npm:@mongolgpt/acme")).toEqual({
      pkg: "@mongolgpt/acme",
      version: "latest",
    })
  })
})
