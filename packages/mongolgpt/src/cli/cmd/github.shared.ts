import type { SessionV1 } from "@mongolgpt/core/v1/session"

export { parseGitHubRemote } from "@/util/repository"

export const MONGOLGPT_GITHUB_ACTION_REF = "sergei10a-rgb/mongolgpt/github@mongolgpt-github-v1.0.0"
export const DEFAULT_GITHUB_MENTIONS = ["/mongolgpt"] as const

export function githubAgentIdentity(useGithubToken: boolean) {
  if (useGithubToken) {
    return {
      username: "github-actions[bot]",
      email: "41898282+github-actions[bot]@users.noreply.github.com",
    }
  }
  return {
    username: "mongolgpt-agent[bot]",
    email: "mongolgpt-agent[bot]@users.noreply.github.com",
  }
}

export function githubMentions(value?: string) {
  const mentions = value
    ?.split(",")
    .map((mention) => mention.trim().toLowerCase())
    .filter(Boolean)
  return mentions?.length ? mentions : [...DEFAULT_GITHUB_MENTIONS]
}

/**
 * Extracts displayable text from assistant response parts.
 * Returns null for non-text responses (signals summary needed).
 * Throws only for truly empty responses.
 */
export function extractResponseText(parts: SessionV1.Part[]): string | null {
  const textPart = parts.findLast((p) => p.type === "text")
  if (textPart) return textPart.text

  // Non-text parts (tools, reasoning, step-start/step-finish, etc.) - signal summary needed
  if (parts.length > 0) return null

  throw new Error("Хариуг parse хийж чадсангүй: part буцаагүй байна")
}

/**
 * Formats a PROMPT_TOO_LARGE error message with details about files in the prompt.
 * Content is base64 encoded, so we calculate original size by multiplying by 0.75.
 */
export function formatPromptTooLargeError(files: { filename: string; content: string }[]): string {
  const fileDetails =
    files.length > 0
      ? `\n\nХүсэлтэд хавсаргасан файлууд:\n${files.map((f) => `  - ${f.filename} (${((f.content.length * 0.75) / 1024).toFixed(0)} KB)`).join("\n")}`
      : ""
  return `PROMPT_TOO_LARGE: Хүсэлтийн агуулга зөвшөөрөгдөх хязгаараас хэтэрлээ.${fileDetails}`
}
