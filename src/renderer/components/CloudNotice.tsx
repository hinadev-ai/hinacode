// oxlint-disable jsx-a11y/prefer-tag-over-role -- The live notice holds a button, which <output> cannot.
import { Link } from "@tanstack/react-router"
import { type Cloud, incompatibleText, useCloud, useThreadEnvironment } from "../lib/environments.ts"
import { formatRelativeTime } from "../lib/relativeTime.ts"
import { useNow } from "../lib/useNow.ts"
import { m } from "../paraglide/messages.js"
import { useLocale } from "../stores/locale.ts"
import { ReconnectButton } from "./ReconnectButton.tsx"
import { Button } from "./ui/button.tsx"
import { CloudOffIcon } from "./icons/CloudOffIcon.tsx"
import { WarningIcon } from "./icons/WarningIcon.tsx"

/** Says above the composer that the thread's cloud cannot take messages right now, and what to do about it. */
export function CloudNotice({ threadId }: { threadId: string }) {
  const cloud = useCloud(useThreadEnvironment(threadId))
  if (cloud === undefined || cloud.status === "connected") return null
  return <CloudNoticeBody cloud={cloud} />
}

const noticeText = (cloud: Cloud, now: number, locale: string) => {
  const { name } = cloud
  switch (cloud.status) {
    case "unauthorized":
      return m.thread_cloud_unauthorized({ name })
    case "incompatible":
      return incompatibleText(cloud)
    default:
      if (cloud.lastSeenAt !== null) {
        return m.thread_cloud_offline({ name, time: formatRelativeTime(cloud.lastSeenAt, now, locale) })
      }
      return cloud.status === "connecting"
        ? m.thread_cloud_connecting({ name })
        : m.thread_cloud_offline_never_seen({ name })
  }
}

function CloudNoticeBody({ cloud }: { cloud: Cloud }) {
  const now = useNow()
  const locale = useLocale((state) => state.locale)
  const text = noticeText(cloud, now, locale)
  const needsYou = cloud.status === "unauthorized" || cloud.status === "incompatible"
  const Icon = needsYou ? WarningIcon : CloudOffIcon

  return (
    <div
      role="status"
      data-needs-you={needsYou}
      className="mb-2 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground data-[needs-you=true]:border-attention/30 data-[needs-you=true]:bg-attention/10 data-[needs-you=true]:text-attention"
    >
      <Icon aria-hidden className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 tabular-nums">{text}</span>
      {cloud.status === "unauthorized" ? (
        <Button
          variant="outline"
          size="sm"
          render={<Link to="/settings" search={{ page: "environments" }} />}
          nativeButton={false}
        >
          {m.environment_pair_again()}
        </Button>
      ) : (
        cloud.status !== "incompatible" && <ReconnectButton cloud={cloud} />
      )}
    </div>
  )
}
