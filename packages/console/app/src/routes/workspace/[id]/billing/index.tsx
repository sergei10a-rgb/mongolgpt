import { SubscriptionSection } from "./subscription-section"
import { PaymentSection } from "./payment-section"

export default function () {
  return (
    <div data-page="workspace-[id]">
      <div data-slot="sections">
        <SubscriptionSection />
        <PaymentSection />
      </div>
    </div>
  )
}
