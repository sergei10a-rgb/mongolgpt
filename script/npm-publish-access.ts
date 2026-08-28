#!/usr/bin/env bun

import { verifyNpmPublishAccess } from "@mongolgpt/script/npm-publish-access"

const result = await verifyNpmPublishAccess({
  token: process.env.NODE_AUTH_TOKEN,
  run: async (args) => {
    const child = Bun.spawn(["npm", ...args], {
      env: Bun.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { status, stdout, stderr }
  },
})

console.log(
  `npm publish эрх баталгаажлаа: ${result.owner} (${result.role}), ${result.cliPackages} CLI package, ${result.platformPackages} platform package`,
)
