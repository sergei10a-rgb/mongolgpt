import { Component, Show } from "solid-js"
import { Dialog } from "@mongolgpt/ui/v2/dialog-v2"
import { TabsV2 } from "@mongolgpt/ui/v2/tabs-v2"
import { Icon } from "@mongolgpt/ui/icon"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { SettingsGeneralV2 } from "./general"
import { SettingsKeybinds } from "../settings-keybinds"
import { SettingsProvidersV2 } from "./providers"
import { SettingsModelsV2 } from "./models"
import "./settings-v2.css"
import { SettingsServersV2 } from "./servers"
import { SettingsImportsV2 } from "./imports"
import { SettingsAccountV2 } from "../settings-account"

export const DialogSettings: Component<{
  sessionID?: string
}> = (props) => {
  const language = useLanguage()
  const platform = usePlatform()

  return (
    <Dialog size="x-large" variant="settings" class="settings-v2-dialog">
      <TabsV2 orientation="vertical" variant="settings" defaultValue="general" class="settings-v2">
        <TabsV2.List>
          <div class="flex flex-col justify-between h-full w-full">
            <div class="flex flex-col gap-3 w-full">
              <div class="flex flex-col gap-3">
                <Show when={platform.account}>
                  <div class="flex flex-col gap-1.5">
                    <TabsV2.SectionTitle>{language.t("settings.section.account")}</TabsV2.SectionTitle>
                    <TabsV2.Trigger
                      value="account"
                      aria-label={language.t("settings.account.tab")}
                      title={language.t("settings.account.tab")}
                    >
                      <Icon name="status" />
                      <span class="settings-v2-nav-label">{language.t("settings.account.tab")}</span>
                    </TabsV2.Trigger>
                  </div>
                </Show>
                <div class="flex flex-col gap-1.5">
                  <TabsV2.SectionTitle>{language.t("settings.section.desktop")}</TabsV2.SectionTitle>
                  <div class="flex flex-col gap-1.5 w-full">
                    <TabsV2.Trigger
                      value="general"
                      aria-label={language.t("settings.tab.general")}
                      title={language.t("settings.tab.general")}
                    >
                      <Icon name="sliders" />
                      <span class="settings-v2-nav-label">{language.t("settings.tab.general")}</span>
                    </TabsV2.Trigger>
                    <TabsV2.Trigger
                      value="shortcuts"
                      aria-label={language.t("settings.tab.shortcuts")}
                      title={language.t("settings.tab.shortcuts")}
                    >
                      <Icon name="keyboard" />
                      <span class="settings-v2-nav-label">{language.t("settings.tab.shortcuts")}</span>
                    </TabsV2.Trigger>
                  </div>
                </div>

                <div class="flex flex-col gap-1.5">
                  <TabsV2.SectionTitle>{language.t("settings.section.server")}</TabsV2.SectionTitle>
                  <div class="flex flex-col gap-1.5 w-full">
                    <TabsV2.Trigger
                      value="servers"
                      aria-label={language.t("status.popover.tab.servers")}
                      title={language.t("status.popover.tab.servers")}
                    >
                      <Icon name="server" />
                      <span class="settings-v2-nav-label">{language.t("status.popover.tab.servers")}</span>
                    </TabsV2.Trigger>
                    <TabsV2.Trigger
                      value="providers"
                      aria-label={language.t("settings.providers.title")}
                      title={language.t("settings.providers.title")}
                    >
                      <Icon name="providers" />
                      <span class="settings-v2-nav-label">{language.t("settings.providers.title")}</span>
                    </TabsV2.Trigger>
                    <TabsV2.Trigger
                      value="models"
                      aria-label={language.t("settings.models.title")}
                      title={language.t("settings.models.title")}
                    >
                      <Icon name="models" />
                      <span class="settings-v2-nav-label">{language.t("settings.models.title")}</span>
                    </TabsV2.Trigger>
                    <TabsV2.Trigger
                      value="imports"
                      aria-label={language.t("settings.imports.title")}
                      title={language.t("settings.imports.title")}
                    >
                      <Icon name="mcp" />
                      <span class="settings-v2-nav-label">{language.t("settings.imports.title")}</span>
                    </TabsV2.Trigger>
                  </div>
                </div>
              </div>
            </div>
            <div class="settings-v2-nav-footer">
              <span>{language.t("app.name.desktop")}</span>
              <span>v{platform.version}</span>
            </div>
          </div>
        </TabsV2.List>
        <Show when={platform.account}>
          <TabsV2.Content value="account" class="settings-v2-panel">
            <SettingsAccountV2 />
          </TabsV2.Content>
        </Show>
        <TabsV2.Content value="general" class="settings-v2-panel">
          <SettingsGeneralV2 sessionID={props.sessionID} />
        </TabsV2.Content>
        <TabsV2.Content value="shortcuts" class="settings-v2-panel">
          <SettingsKeybinds v2 />
        </TabsV2.Content>
        <TabsV2.Content value="servers" class="settings-v2-panel">
          <SettingsServersV2 />
        </TabsV2.Content>
        <TabsV2.Content value="providers" class="settings-v2-panel">
          <SettingsProvidersV2 />
        </TabsV2.Content>
        <TabsV2.Content value="models" class="settings-v2-panel">
          <SettingsModelsV2 />
        </TabsV2.Content>
        <TabsV2.Content value="imports" class="settings-v2-panel">
          <SettingsImportsV2 />
        </TabsV2.Content>
      </TabsV2>
    </Dialog>
  )
}
