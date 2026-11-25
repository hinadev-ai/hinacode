// oxlint-disable jsx-a11y/prefer-tag-over-role -- The live notice holds a button, which <output> cannot.
import { Link } from "@tanstack/react-router"
import {
  approvalText,
  type Cloud,
  incompatibleText,
  needsYou as needsAttention,
  refusalText,
  repairsFromRelay,
  useCloud,
  useClouds,
  useThreadEnvironment,
} from "../lib/environments.ts"
import { formatRelativeTime } from "../lib/relativeTime.ts"
import { useNow } from "../lib/useNow.ts"
import { m } from "../paraglide/messages.js"
import { useLocale } from "../stores/locale.ts"
import { ConfirmHostButtons, RepairButton } from "./HostApproval.tsx"
import { ReconnectButton } from "./ReconnectButton.tsx"
import { ReloadPageButton } from "./ReloadPageButton.tsx"
import { inBrowser } from "../lib/runtime.ts"
import { buttonVariants } from "./ui/button.tsx"
import { CloudOffIcon, WarningIcon } from "@hinacode/icons"

export function CloudNotice({ threadId }: { threadId: string }) {
  const cloud = useCloud(useThreadEnvironment(threadId))
  if (cloud === undefined || cloud.status === "connected") return null
  return <CloudNoticeBody cloud={cloud} />
}

export function MachineApprovalNotices({ className }: { className?: string }) {
  const waiting = useClouds().filter((cloud) => cloud.status === "approval")
  if (waiting.length === 0) return null
  return (
    <div className={className}>
      {waiting.map((cloud) => (
        <CloudNoticeBody key={cloud.id} cloud={cloud} />
      ))}
    </div>
  )
}

const noticeText = (cloud: Cloud, now: number, locale: string) => {
  const { name } = cloud
  switch (cloud.status) {
    case "approval":
      return approvalText(cloud)
    case "unauthorized":
      return refusalText(cloud)
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
  const needsYou = needsAttention(cloud)
  const Icon = needsYou ? WarningIcon : CloudOffIcon

  return (
    <div
      role="status"
      data-needs-you={needsYou}
      className="mb-2 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground data-[needs-you=true]:border-attention/30 data-[needs-you=true]:bg-attention/10 data-[needs-you=true]:text-attention"
    >
      <Icon aria-hidden className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 tabular-nums">{text}</span>
      {cloud.status === "approval" ? (
        <ConfirmHostButtons cloud={cloud} />
      ) : repairsFromRelay(cloud) ? (
        <RepairButton cloud={cloud} />
      ) : cloud.status === "unauthorized" && inBrowser() ? (
        <ReloadPageButton />
      ) : cloud.status === "unauthorized" ? (
        <Link
          to="/settings"
          search={{ page: "connections" }}
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          {m.environment_pair_again()}
        </Link>
      ) : (
        cloud.status !== "incompatible" && <ReconnectButton cloud={cloud} />
      )}
    </div>
  )
}
