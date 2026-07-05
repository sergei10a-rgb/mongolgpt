import { DialogSelect } from "../../ui/dialog-select"
import { useRoute } from "../../context/route"

export function DialogSubagent(props: { sessionID: string }) {
  const route = useRoute()

  return (
    <DialogSelect
      title="Subagent үйлдлүүд"
      options={[
        {
          title: "Нээх",
          value: "subagent.view",
          description: "subagent-ийн сешн",
          onSelect: (dialog) => {
            route.navigate({
              type: "session",
              sessionID: props.sessionID,
            })
            dialog.clear()
          },
        },
      ]}
    />
  )
}
