import { SubscriptionSection } from "./subscription-section"

export default function () {
  return (
    <div data-page="workspace-[id]">
      <div data-slot="sections">
        <SubscriptionSection />
      </div>
    </div>
  )
}
