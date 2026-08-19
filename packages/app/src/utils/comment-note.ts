import type { FileSelection } from "@/context/file"

export type PromptComment = {
  path: string
  selection?: FileSelection
  comment: string
  preview?: string
  origin?: "review" | "file"
}

function selection(selection: unknown) {
  if (!selection || typeof selection !== "object") return undefined
  const startLine = Number((selection as FileSelection).startLine)
  const startChar = Number((selection as FileSelection).startChar)
  const endLine = Number((selection as FileSelection).endLine)
  const endChar = Number((selection as FileSelection).endChar)
  if (![startLine, startChar, endLine, endChar].every(Number.isFinite)) return undefined
  return {
    startLine,
    startChar,
    endLine,
    endChar,
  } satisfies FileSelection
}

export function createCommentMetadata(input: PromptComment) {
  return {
    mongolgptComment: {
      path: input.path,
      selection: input.selection,
      comment: input.comment,
      preview: input.preview,
      origin: input.origin,
    },
  }
}

export function readCommentMetadata(value: unknown) {
  if (!value || typeof value !== "object") return
  const meta = (value as { mongolgptComment?: unknown }).mongolgptComment
  if (!meta || typeof meta !== "object") return
  const path = (meta as { path?: unknown }).path
  const comment = (meta as { comment?: unknown }).comment
  if (typeof path !== "string" || typeof comment !== "string") return
  const preview = (meta as { preview?: unknown }).preview
  const origin = (meta as { origin?: unknown }).origin
  return {
    path,
    selection: selection((meta as { selection?: unknown }).selection),
    comment,
    preview: typeof preview === "string" ? preview : undefined,
    origin: origin === "review" || origin === "file" ? origin : undefined,
  } satisfies PromptComment
}

export function formatCommentNote(input: { path: string; selection?: FileSelection; comment: string }) {
  const start = input.selection ? Math.min(input.selection.startLine, input.selection.endLine) : undefined
  const end = input.selection ? Math.max(input.selection.startLine, input.selection.endLine) : undefined
  const location =
    start === undefined || end === undefined
      ? `${input.path} файлын тухай`
      : start === end
        ? `${input.path} файлын ${start}-р мөрийн тухай`
        : `${input.path} файлын ${start}-${end}-р мөрүүдийн тухай`
  return `Хэрэглэгч ${location} дараах санал үлдээв: ${input.comment}`
}

export function parseCommentNote(text: string) {
  const match = text.match(
    /^Хэрэглэгч (.+?) файлын (тухай|(\d+)-р мөрийн тухай|(\d+)-(\d+)-р мөрүүдийн тухай) дараах санал үлдээв: ([\s\S]+)$/,
  )
  if (match) {
    const start = match[3] ? Number(match[3]) : match[4] ? Number(match[4]) : undefined
    const end = match[3] ? Number(match[3]) : match[5] ? Number(match[5]) : undefined
    return {
      path: match[1],
      selection:
        start !== undefined && end !== undefined
          ? {
              startLine: start,
              startChar: 0,
              endLine: end,
              endChar: 0,
            }
          : undefined,
      comment: match[6],
    } satisfies PromptComment
  }

  const legacy = text.match(
    /^The user made the following comment regarding (this file|line (\d+)|lines (\d+) through (\d+)) of (.+?): ([\s\S]+)$/,
  )
  if (!legacy) return
  const start = legacy[2] ? Number(legacy[2]) : legacy[3] ? Number(legacy[3]) : undefined
  const end = legacy[2] ? Number(legacy[2]) : legacy[4] ? Number(legacy[4]) : undefined
  return {
    path: legacy[5],
    selection:
      start !== undefined && end !== undefined
        ? {
            startLine: start,
            startChar: 0,
            endLine: end,
            endChar: 0,
          }
        : undefined,
    comment: legacy[6],
  } satisfies PromptComment
}
