export function formatAdminDate(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "Тодорхойгүй огноо"
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: "Asia/Ulaanbaatar",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  )
  return `${parts.year} оны ${Number(parts.month)}-р сарын ${Number(parts.day)}, ${parts.hour}:${parts.minute}`
}
