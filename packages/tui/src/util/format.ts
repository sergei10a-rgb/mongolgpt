export function formatDuration(secs: number) {
  if (secs <= 0) return ""
  if (secs < 60) return `${secs} сек`
  if (secs < 3600) {
    const mins = Math.floor(secs / 60)
    const remaining = secs % 60
    return remaining > 0 ? `${mins} мин ${remaining} сек` : `${mins} мин`
  }
  if (secs < 86400) {
    const hours = Math.floor(secs / 3600)
    const remaining = Math.floor((secs % 3600) / 60)
    return remaining > 0 ? `${hours} цаг ${remaining} мин` : `${hours} цаг`
  }
  if (secs < 604800) {
    const days = Math.floor(secs / 86400)
    return `~${days} хоног`
  }
  const weeks = Math.floor(secs / 604800)
  return `~${weeks} долоо хоног`
}
