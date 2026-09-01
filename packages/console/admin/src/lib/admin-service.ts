export type AdminServiceReference = {
  url: string
}

export function resolveAdminServiceURL(service: AdminServiceReference, path: string) {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || /[\r\n]/.test(path)) {
    throw new Error("Админ үйлчилгээний зам хүчинтэй биш байна.")
  }

  let base: URL
  try {
    base = new URL(service.url)
  } catch {
    throw new Error("Админ үйлчилгээний URL хүчинтэй биш байна.")
  }
  if (
    base.protocol !== "https:" ||
    !base.hostname ||
    base.username ||
    base.password ||
    base.port ||
    base.pathname !== "/" ||
    base.search ||
    base.hash
  ) {
    throw new Error("Админ үйлчилгээний URL аюулгүй HTTPS origin байна.")
  }

  const result = new URL(path, base)
  if (result.origin !== base.origin) throw new Error("Админ үйлчилгээний зам origin солих ёсгүй.")
  return result
}

export function fetchAdminService(service: AdminServiceReference, path: string, init?: RequestInit) {
  const request = adminServiceRequest(service, path, init)
  return fetch(request.url, request.init)
}

export function adminServiceRequest(service: AdminServiceReference, path: string, init?: RequestInit) {
  return {
    url: resolveAdminServiceURL(service, path),
    init: { ...init, redirect: "error" as const },
  }
}
