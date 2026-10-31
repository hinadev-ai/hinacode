import { type Cloud, useCloudStateText } from "../lib/environments.ts"
import { m } from "../paraglide/messages.js"
import { CloudIcon } from "./icons/CloudIcon.tsx"
import { CloudOffIcon } from "./icons/CloudOffIcon.tsx"

/**
 * Marks a project or thread that lives on a cloud. The cloud is crossed out while it is not connected, and the label
 * names the machine and its state.
 */
export function CloudMark({ cloud, id, className }: { cloud: Cloud; id?: string; className: string }) {
  const state = useCloudStateText(cloud)
  const label =
    state === null
      ? m.environment_on({ environment: cloud.name })
      : m.environment_on_state({ environment: cloud.name, state })
  const Icon = state === null ? CloudIcon : CloudOffIcon
  return (
    <span
      title={label}
      data-needs-you={cloud.status === "unauthorized" || cloud.status === "incompatible"}
      className="flex shrink-0 items-center text-muted-foreground data-[needs-you=true]:text-attention"
    >
      <Icon aria-hidden className={className} />
      <span id={id} className="sr-only">
        {label}
      </span>
    </span>
  )
}
