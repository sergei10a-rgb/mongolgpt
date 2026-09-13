export const consoleBaselineCommit = "9f4f5757eedc1bb02eb95160bdaa87e04ec59dc5"
export const consoleFixCommit = "41d58f4dbc8c9b88cdf19e22745b126ce3f54235"

const expected = [
  "M\tpackages/console/app/src/component/header.tsx",
  "M\tpackages/console/app/src/routes/download/index.tsx",
  "M\tpackages/console/app/src/routes/index.tsx",
  "M\tpackages/console/app/src/routes/pricing/index.tsx",
  "M\tpackages/console/app/src/routes/support/index.tsx",
  "A\tpackages/console/app/test/auth-navigation-contract.test.ts",
].sort()

export function verifyConsoleAuthPatch(value: string) {
  const files = value.trim().split(/\r?\n/).sort()
  if (JSON.stringify(files) !== JSON.stringify(expected)) throw new Error("Unapproved Console auth release files")
}
