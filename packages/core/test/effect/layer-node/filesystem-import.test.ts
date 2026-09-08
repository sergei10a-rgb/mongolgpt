import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { tmpdir } from "../../fixture/tmpdir"

for (const first of ["filesystem/search", "filesystem"]) {
  test(`filesystem graph resolves after cold ${first} import`, async () => {
    await using tmp = await tmpdir()
    const child = spawnSync(
      process.execPath,
      [
        "--eval",
        `
      import assert from "node:assert/strict";
      await import("./src/${first}.ts");
      const { FileSystem } = await import("./src/filesystem.ts");
      const { FileSystemSearch } = await import("./src/filesystem/search.ts");
      assert.ok(FileSystemSearch.node);
      assert.equal(FileSystem.node.dependencies[2], FileSystemSearch.node);
      const { LayerNodeTree } = await import("./src/effect/layer-node/index.ts");
      const { Location } = await import("./src/location.ts");
      const graph = LayerNodeTree.bind(FileSystem.node, Location.node, Location.boundNode({ directory: process.cwd() }));
      LayerNodeTree.compile(graph);
      console.log("filesystem graph complete");
    `,
      ],
      {
        cwd: fileURLToPath(new URL("../../../", import.meta.url)),
        env: {
          ...process.env,
          HOME: tmp.path,
          XDG_DATA_HOME: `${tmp.path}/data`,
          XDG_CACHE_HOME: `${tmp.path}/cache`,
          XDG_CONFIG_HOME: `${tmp.path}/config`,
          XDG_STATE_HOME: `${tmp.path}/state`,
        },
        encoding: "utf8",
        timeout: 30_000,
        windowsHide: true,
      },
    )
    expect(child.status, child.stderr).toBe(0)
    expect(child.stdout).toContain("filesystem graph complete")
  }, 35_000)
}
