import { Context } from "effect"
import type { InstanceContext } from "@/project/instance-context"
import type { WorkspaceV2 } from "@mongolgpt/core/workspace"

export const InstanceRef = Context.Reference<InstanceContext | undefined>("~mongolgpt/InstanceRef", {
  defaultValue: () => undefined,
})

export const WorkspaceRef = Context.Reference<WorkspaceV2.ID | undefined>("~mongolgpt/WorkspaceRef", {
  defaultValue: () => undefined,
})
