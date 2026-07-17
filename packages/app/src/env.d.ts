interface ImportMetaEnv {
  readonly VITE_MONGOLGPT_SERVER_HOST: string
  readonly VITE_MONGOLGPT_SERVER_PORT: string
  readonly VITE_MONGOLGPT_SERVER_URL?: string
  readonly VITE_MONGOLGPT_RUNTIME_MODE?: "local-bridge" | "hosted"
  readonly VITE_MONGOLGPT_CHANNEL?: "dev" | "beta" | "prod"

  readonly VITE_SENTRY_DSN?: string
  readonly VITE_SENTRY_ENVIRONMENT?: string
  readonly VITE_SENTRY_RELEASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

export declare module "solid-js" {
  namespace JSX {
    interface Directives {
      sortable: true
    }
  }
}
