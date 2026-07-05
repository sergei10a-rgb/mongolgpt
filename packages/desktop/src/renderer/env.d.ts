import type { ElectronAPI } from "../preload/types"

interface ImportMetaEnv {
  readonly VITE_MONGOLGPT_CHANNEL?: "dev" | "beta" | "prod"
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare global {
  interface Window {
    api: ElectronAPI
    __MONGOLGPT__?: {
      deepLinks?: string[]
    }
  }
}
