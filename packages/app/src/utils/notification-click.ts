let nav: ((href: string) => void) | undefined

export const setNavigate = (fn: (href: string) => void) => {
  nav = fn
}

export const handleNotificationClick = (href?: string) => {
  window.focus()
  if (!href) return
  if (nav) return nav(href)
  console.warn("notification-click: navigate функц тохируулаагүй тул window.location.assign ашиглаж байна")
  window.location.assign(href)
}
