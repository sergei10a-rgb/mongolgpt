interface ImportMetaEnv {
  readonly VITE_MONGOLGPT_CHANNEL: string
  readonly MONGOLGPT_CHANNEL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module "virtual:mongolgpt-server" {
  export namespace Server {
    export const listen: typeof import("../../../mongolgpt/dist/types/src/node").Server.listen
    export type Listener = import("../../../mongolgpt/dist/types/src/node").Server.Listener
  }
  export namespace Config {
    export const get: typeof import("../../../mongolgpt/dist/types/src/node").Config.get
    export type Info = import("../../../mongolgpt/dist/types/src/node").Config.Info
  }
  export const bootstrap: typeof import("../../../mongolgpt/dist/types/src/node").bootstrap
}
