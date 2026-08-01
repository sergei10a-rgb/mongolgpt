import { SettingsSection } from "./settings-section"
import { AccountDeletionSection } from "./account-deletion-section"

export default function () {
  return (
    <div data-page="workspace-[id]">
      <div data-slot="sections">
        <SettingsSection />
        <AccountDeletionSection />
      </div>
    </div>
  )
}
