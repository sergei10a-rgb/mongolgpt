const stagePattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

export const deploymentStageIssue =
  "Deployment stage нь жижиг латин үсэг, тоо, дундах зураасаас бүрдэх бөгөөд яг тэр хэлбэрээр өгөгдөнө."

export function inspectDeploymentStage(input: string | undefined) {
  const raw = input ?? ""
  const trimmed = raw.trim()
  const stage = trimmed.toLowerCase()
  const valid = raw === trimmed && trimmed === stage && stagePattern.test(stage)
  return { stage, issue: valid ? undefined : deploymentStageIssue }
}

export function requireDeploymentStage(input: string | undefined) {
  const result = inspectDeploymentStage(input)
  if (result.issue) throw new Error(result.issue)
  return result.stage
}
