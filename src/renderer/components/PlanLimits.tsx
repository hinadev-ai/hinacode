// oxlint-disable jsx-a11y/prefer-tag-over-role, jsx-a11y/no-noninteractive-tabindex -- a native <meter> cannot hold the group's text, and the meter takes focus so keyboard users can open its tooltip.
import { useAtomValue } from "@effect/atom-react"
import { cn } from "cn"
import { AsyncResult } from "effect/reactivity"
import { Fragment } from "react"
import type { AccountLimits, ProviderId } from "../../shared/agent.ts"
import type { Thread } from "../../shared/domain.ts"
import type { LimitWindow, LimitWindowKind } from "../../shared/limits.ts"
import { formatMinutes, formatResetIn, limitLevel, mostUsed } from "../lib/planLimits.ts"
import { accountAtom, accountLimitsAtom, accountsAtom } from "../lib/rpc.ts"
import { useSettings } from "../lib/settings.ts"
import { useNow } from "../lib/useNow.ts"
import { m } from "../paraglide/messages.js"
import { getLocale } from "../paraglide/runtime.js"
import { ProviderIcon, providerLabel } from "./ProviderIcon.tsx"
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.tsx"

const levelText = { normal: "", warning: "text-attention", exhausted: "text-destructive" }
const levelFill = { normal: "bg-muted-foreground", warning: "bg-attention", exhausted: "bg-destructive" }

export const windowLabel = (window: LimitWindowKind) => {
  switch (window.kind) {
    case "session":
      return m.limits_session()
    case "weekly":
      return m.limits_weekly()
    case "model":
      return window.name
    case "minutes":
      return formatMinutes(window.minutes, getLocale())
  }
}

const percentOf = (window: LimitWindow) => Math.round(window.usedPercent)

/** "Resets in 2h 10m, Mon 3:40 PM". */
export const resetLabel = (resetsAt: string, now: number, locale: string) =>
  m.limits_resets_in({
    duration: formatResetIn(resetsAt, now, locale),
    time: new Intl.DateTimeFormat(locale, { weekday: "short", hour: "numeric", minute: "2-digit" }).format(
      Date.parse(resetsAt),
    ),
  })

type Shown = AccountLimits & { readonly windows: ReadonlyArray<LimitWindow> }

/**
 * One group per account with plan limits. A provider's only account, or the one the open thread uses, shows
 * every window; any other collapses to its top percentage.
 */
export function PlanLimits({ openThread }: { openThread: Pick<Thread, "provider" | "accountId"> | undefined }) {
  const entries = AsyncResult.getOrElse(useAtomValue(accountLimitsAtom), () => [])
  // Limits carry no environment, so account names and sign-ins come from this machine.
  const added = AsyncResult.getOrElse(useAtomValue(accountsAtom(null)), () => [])
  const { defaultAccountName } = useSettings(null)
  const shown = entries.flatMap((entry): ReadonlyArray<Shown> => {
    const windows = entry.limits?.windows ?? []
    return windows.length === 0 ? [] : [{ ...entry, windows }]
  })
  const groupsOf = (provider: ProviderId) => shown.filter((entry) => entry.provider === provider).length
  // The CLI's own login needs a name only next to the provider's added accounts.
  const nameOf = (entry: Shown) =>
    entry.accountId === null
      ? groupsOf(entry.provider) > 1
        ? (defaultAccountName[entry.provider] ?? m.account_default())
        : undefined
      : added.find((account) => account.id === entry.accountId)?.name
  return shown.map((entry) => (
    <AccountLimitsGroup
      key={`${entry.provider}:${entry.accountId ?? ""}`}
      provider={entry.provider}
      accountId={entry.accountId}
      name={nameOf(entry)}
      windows={entry.windows}
      expanded={
        groupsOf(entry.provider) === 1 ||
        (entry.provider === openThread?.provider && entry.accountId === openThread.accountId)
      }
    />
  ))
}

export function AccountLimitsGroup({
  provider,
  accountId,
  name,
  windows,
  expanded,
}: {
  provider: ProviderId
  accountId: string | null
  /** Tells a provider's accounts apart. */
  name: string | undefined
  windows: ReadonlyArray<LimitWindow>
  expanded: boolean
}) {
  const now = useNow()
  const locale = getLocale()
  const top = mostUsed(windows)!
  const topPercent = percentOf(top)
  const detailOf = (window: LimitWindow) =>
    window.window.kind === "model"
      ? window.window.name
      : window.resetsAt === null
        ? null
        : formatResetIn(window.resetsAt, now, locale)

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="meter"
            tabIndex={0}
            aria-label={
              name === undefined
                ? m.limits_label({ provider: providerLabel[provider]() })
                : m.limits_label_account({ provider: providerLabel[provider](), name })
            }
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.min(topPercent, 100)}
            aria-valuetext={m.limits_value({ percent: topPercent, window: windowLabel(top.window) })}
            className="inline-flex h-5 shrink-0 items-center gap-1.5 rounded-sm px-1.5 whitespace-nowrap tabular-nums outline-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ProviderIcon provider={provider} />
            {name !== undefined && <span>{name}</span>}
            <Meter percent={top.usedPercent} />
            {expanded ? (
              windows.map((window, index) => {
                const detail = detailOf(window)
                const percent = percentOf(window)
                return (
                  <Fragment key={index}>
                    {index > 0 && <span aria-hidden>·</span>}
                    <span className={levelText[limitLevel(window.usedPercent)]}>
                      {detail === null ? m.limits_used({ percent }) : m.limits_used_detail({ percent, detail })}
                    </span>
                  </Fragment>
                )
              })
            ) : (
              <span className={levelText[limitLevel(top.usedPercent)]}>{topPercent}%</span>
            )}
          </span>
        }
      />
      <TooltipContent side="top" align="start" className="max-w-none flex-col items-stretch gap-2 py-2">
        <AccountHeading provider={provider} accountId={accountId} name={name} />
        <table className="tabular-nums">
          <tbody>
            {windows.map((window, index) => (
              <tr key={index}>
                <th scope="row" className="pt-1 pr-4 text-left font-medium">
                  {windowLabel(window.window)}
                </th>
                <td className="pt-1 pr-4 text-right">{m.limits_used({ percent: percentOf(window) })}</td>
                <td className="pt-1 text-background/70">
                  {window.resetsAt === null ? m.limits_no_reset() : resetLabel(window.resetsAt, now, locale)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </TooltipContent>
    </Tooltip>
  )
}

function AccountHeading({
  provider,
  accountId,
  name,
}: {
  provider: ProviderId
  accountId: string | null
  name: string | undefined
}) {
  const account = AsyncResult.getOrElse(useAtomValue(accountAtom(null, provider, accountId)), () => null)
  const details = [name, ...(account?.type === "subscription" ? [account.email, account.plan] : [])].filter(
    (detail) => detail != null,
  )
  return (
    <p>
      <span className="font-medium">{providerLabel[provider]()}</span>
      {details.length > 0 && <span className="text-background/70"> · {details.join(" · ")}</span>}
    </p>
  )
}

function Meter({ percent }: { percent: number }) {
  return (
    <span aria-hidden className="h-1.5 w-12 shrink-0 overflow-hidden rounded-full bg-border">
      <span
        className={cn("block h-full rounded-full", levelFill[limitLevel(percent)])}
        style={{ width: `${Math.min(Math.max(percent, 0), 100)}%` }}
      />
    </span>
  )
}
