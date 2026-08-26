import { A } from "@solidjs/router"
import { Show } from "solid-js"
import type { PlatformAdminContext } from "~/lib/admin-context"

export function AdminHeader(props: { admin: PlatformAdminContext; active: "overview" | "users" | "billing" | "admins" }) {
  return (
    <header data-component="admin-header">
      <div data-component="admin-branding">
        <A href="/" data-component="brand" aria-label="MongolGPT удирдлагын нүүр">
          <span data-component="brand-mark" aria-hidden="true">
            M
          </span>
          <span>
            <strong>MongolGPT</strong>
            <small>Удирдлага</small>
          </span>
        </A>
        <nav data-component="admin-nav" aria-label="Удирдлагын үндсэн цэс">
          <A href="/" data-active={props.active === "overview" ? "true" : undefined}>
            Хяналт
          </A>
          <Show when={props.admin.permissions.includes("users.read")}>
            <A href="/users" data-active={props.active === "users" ? "true" : undefined}>
              Хэрэглэгч
            </A>
          </Show>
          <Show when={props.admin.permissions.includes("billing.read")}>
            <A href="/billing" data-active={props.active === "billing" ? "true" : undefined}>
              Санхүү
            </A>
          </Show>
          <Show when={props.admin.permissions.includes("admins.manage") && props.admin.role === "owner"}>
            <A href="/admins" data-active={props.active === "admins" ? "true" : undefined}>
              Оператор
            </A>
          </Show>
        </nav>
      </div>
      <div data-component="admin-identity">
        <span>{roleLabel(props.admin.role)}</span>
        <strong>{props.admin.email}</strong>
      </div>
    </header>
  )
}

export function roleLabel(role: string) {
  return (
    {
      owner: "Эзэмшигч",
      administrator: "Ерөнхий админ",
      support: "Хэрэглэгчийн тусламж",
      finance: "Санхүү",
      operations: "Системийн ажиллагаа",
    }[role] ?? `Тодорхойгүй эрх (${role})`
  )
}
