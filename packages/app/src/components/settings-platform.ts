export function settingsPlatformLabels(platform: "web" | "desktop") {
  return platform === "web"
    ? ({ section: "settings.section.web", app: "app.name.web" } as const)
    : ({ section: "settings.section.desktop", app: "app.name.desktop" } as const)
}
