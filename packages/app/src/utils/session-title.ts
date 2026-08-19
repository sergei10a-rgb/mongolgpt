const pattern = /^(New session|Child session|Шинэ сешн|Дэд сешн) - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

type SessionTitleKey = "session.title.new" | "session.title.child"
type TranslateSessionTitle = (key: SessionTitleKey) => string

export function sessionTitle(title?: string, t?: TranslateSessionTitle) {
  if (!title) return title
  const match = title.match(pattern)
  if (!match) return title
  if (!t) return match[1]
  return t(match[1] === "Child session" || match[1] === "Дэд сешн" ? "session.title.child" : "session.title.new")
}
