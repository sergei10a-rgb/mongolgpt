import { Show } from "solid-js"
import { adminActionFeedback } from "~/lib/admin-response"

export function AdminActionMessage(props: { result: unknown; error: unknown }) {
  return (
    <Show when={adminActionFeedback(props.result, props.error)}>
      {(result) => (
        <p
          data-component="action-message"
          data-outcome={result().ok ? "success" : "failure"}
          role={result().ok ? "status" : "alert"}
          aria-live="polite"
        >
          {result().message}
        </p>
      )}
    </Show>
  )
}
