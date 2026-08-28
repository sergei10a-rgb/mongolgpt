export const hostedAppUrl = import.meta.env.VITE_MONGOLGPT_APP_URL
export const hostedRuntimeUrl = import.meta.env.VITE_MONGOLGPT_RUNTIME_URL
export const hostedConsoleUrl = import.meta.env.VITE_MONGOLGPT_PUBLIC_URL
export const hostedRootUrl = import.meta.env.VITE_MONGOLGPT_ROOT_URL
export const hostedFreeWorkspaceIDs = import.meta.env.VITE_MONGOLGPT_FREE_WORKSPACE_IDS
export const hostedTurnstileEnabled = import.meta.env.VITE_MONGOLGPT_TURNSTILE_ENABLED === "true"
export const hostedTurnstileSiteKey = import.meta.env.VITE_MONGOLGPT_TURNSTILE_SITE_KEY?.trim() ?? ""
