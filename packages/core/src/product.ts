import { InstallationChannel } from "./installation/version"

export const repositoryUrl = "https://github.com/sergei10a-rgb/mongolgpt"
export const releasesUrl = `${repositoryUrl}/releases`
export const repositorySupportUrl = `${repositoryUrl}/issues`
export const documentationRepositoryUrl = `${repositoryUrl}/tree/main/packages/web/src/content/docs`
export const installScriptUrl = "https://raw.githubusercontent.com/sergei10a-rgb/mongolgpt/main/install"
export const schemaBaseUrl =
  "https://raw.githubusercontent.com/sergei10a-rgb/mongolgpt/main/packages/web/public"
export const configSchemaUrl = `${schemaBaseUrl}/config.json`
export const tuiSchemaUrl = `${schemaBaseUrl}/tui.json`
export const themeSchemaUrl = `${schemaBaseUrl}/theme.json`
export const desktopThemeSchemaUrl = `${schemaBaseUrl}/desktop-theme.json`
export const localConsoleUrl = "http://localhost:3000"
export const localAuthUrl = `${localConsoleUrl}/auth`
export const localWebAppUrl = "http://localhost:4444"

export function resolveProductServiceUrls(channel: string) {
  if (channel === "latest" || channel === "production" || channel === "prod") {
    return {
      console: "https://mgpt.mn",
      auth: "https://auth.mgpt.mn",
      app: "https://app.mgpt.mn",
      docs: "https://docs.mgpt.mn/docs",
    }
  }

  if (channel === "dev" || channel === "main" || channel === "beta") {
    return {
      console: "https://dev.mgpt.mn",
      auth: "https://auth.dev.mgpt.mn",
      app: "https://app.dev.mgpt.mn",
      docs: "https://docs.dev.mgpt.mn/docs",
    }
  }

  return {
    console: localConsoleUrl,
    auth: localAuthUrl,
    app: localWebAppUrl,
    docs: "http://localhost:4321/docs",
  }
}

export const productServiceUrls = resolveProductServiceUrls(InstallationChannel)
