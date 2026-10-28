// oxlint-disable jsx-a11y/prefer-tag-over-role -- The live notice holds a button and its error, which <output> cannot.
import { useAtomValue } from "@effect/atom-react"
import { AsyncResult } from "effect/reactivity"
import { useActionState } from "react"
import { RiErrorWarningLine } from "react-icons/ri"
import type { AccountLimits } from "../../shared/agent.ts"
import type { Thread } from "../../shared/domain.ts"
import type { LimitWindow, LimitWindowKind } from "../../shared/limits.ts"
import { errorMessage } from "../lib/errorMessage.ts"
import { useThreadEnvironment } from "../lib/environments.ts"
import { formatMinutes, formatResetIn, mostUsed, spentWindow } from "../lib/planLimits.ts"
import { accountLimitsAtom, callPromise } from "../lib/rpc.ts"
import { useNow } from "../lib/useNow.ts"
import { m } from "../paraglide/messages.js"
import { getLocale } from "../paraglide/runtime.js"
import { useThreads } from "../stores/threads.ts"
import { useDefaultAccountName, useProviderAccounts } from "./settings/AccountSettings.tsx"
import { Button } from "./ui/button.tsx"
import { FieldError } from "./ui/field.tsx"

const windowLabel = (window: LimitWindowKind) => {
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

/** "Resets in 2h 10m, Mon 3:40 PM". */
const resetLabel = (resetsAt: string, now: number, locale: string) =>
  m.limits_resets_in({
    duration: formatResetIn(resetsAt, now, locale),
    time: new Intl.DateTimeFormat(locale, { weekday: "short", hour: "numeric", minute: "2-digit" }).format(
      Date.parse(resetsAt),
    ),
  })

type AccountThread = Pick<Thread, "id" | "provider" | "accountId" | "model">

export interface AccountOption {
  /** Null is the CLI's own login. */
  readonly id: string | null
  readonly name: string
  /** Undefined when the plan limits are unknown, such as for an API key or a remote environment's account. */
  readonly mostUsed: LimitWindow | undefined
  /** The window that keeps the account from running the thread's model. */
  readonly spent: LimitWindow | undefined
}

export function useAccountOptions(thread: AccountThread) {
  const environment = useThreadEnvironment(thread.id)
  const added = useProviderAccounts(environment, thread.provider)
  const defaultName = useDefaultAccountName(environment, thread.provider)
  const limits = AsyncResult.getOrElse(useAtomValue(accountLimitsAtom), (): ReadonlyArray<AccountLimits> => [])
  const windowsOf = (id: string | null) =>
    environment === null
      ? (limits.find((entry) => entry.provider === thread.provider && entry.accountId === id)?.limits?.windows ?? [])
      : []
  const options = [{ id: null, name: defaultName }, ...added].map(({ id, name }): AccountOption => {
    const windows = windowsOf(id)
    return { id, name, mostUsed: mostUsed(windows), spent: spentWindow(windows, thread.model) }
  })
  const current = options.find((option) => option.id === thread.accountId)
  const suggestion = options
    .filter((option) => option !== current && option.mostUsed !== undefined && option.spent === undefined)
    .toSorted((a, b) => (a.mostUsed?.usedPercent ?? 0) - (b.mostUsed?.usedPercent ?? 0))[0]
  return { options, current, suggestion }
}

/** What the account picker says under an account's name. */
export function useAccountHint() {
  const now = useNow()
  const locale = getLocale()
  return (option: AccountOption) =>
    option.spent !== undefined
      ? option.spent.resetsAt === null
        ? m.account_limit_reached_no_reset()
        : m.account_limit_reached({ duration: formatResetIn(option.spent.resetsAt, now, locale) })
      : option.mostUsed !== undefined
        ? m.limits_used({ percent: Math.round(option.mostUsed.usedPercent) })
        : undefined
}

/** Moves the thread to `accountId`, carrying its conversation over. `resend` runs the last prompt again there. */
export async function switchAccount(threadId: string, accountId: string | null, resend = false) {
  useThreads.getState().upsert(await callPromise("threads.switchAccount", { id: threadId, accountId, resend }))
}

/** A button that switches the thread to `to`, showing the error beside it when the switch is refused. */
export function SwitchAccountButton({
  threadId,
  to,
  resend,
  label,
}: {
  threadId: string
  to: AccountOption
  resend: boolean
  label: string
}) {
  const [error, run, isPending] = useActionState(async () => {
    try {
      await switchAccount(threadId, to.id, resend)
      return null
    } catch (cause) {
      return errorMessage(cause)
    }
  }, null)
  return (
    <>
      <Button type="button" variant="outline" size="sm" disabled={isPending} aria-busy={isPending} action={run}>
        {label}
      </Button>
      {error && <FieldError>{error}</FieldError>}
    </>
  )
}

/** Shown above the composer when the thread's account has spent a window, before anything is sent to it. */
export function AccountLimitNotice({ thread }: { thread: AccountThread }) {
  const { current, suggestion } = useAccountOptions(thread)
  const now = useNow()
  const spent = current?.spent
  if (current === undefined || spent === undefined) return null
  return (
    <div
      role="status"
      className="mb-2 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-attention/30 bg-attention/10 px-3 py-2 text-sm"
    >
      <RiErrorWarningLine aria-hidden className="size-4 shrink-0 text-attention" />
      <span className="min-w-0 flex-1">
        <span className="font-medium text-attention">
          {m.account_limit_notice({ window: windowLabel(spent.window), account: current.name })}
        </span>
        {spent.resetsAt !== null && (
          <span className="text-muted-foreground tabular-nums"> {resetLabel(spent.resetsAt, now, getLocale())}</span>
        )}
      </span>
      {suggestion && (
        <SwitchAccountButton
          key={suggestion.id}
          threadId={thread.id}
          to={suggestion}
          resend={false}
          label={m.account_switch_to({ account: suggestion.name })}
        />
      )}
    </div>
  )
}
