import { useEffect } from "react"
import { toast } from "sonner"
import { onPushEvent } from "../lib/rpc.ts"
import { m } from "../paraglide/messages.js"
import { getLocale } from "../paraglide/runtime.js"

/** Warns when main reports the GitHub budget running low or used up. Main sends each level once per window. */
export function useGitHubRateLimitNotices() {
  useEffect(
    () =>
      onPushEvent((event) => {
        if (event.type !== "github.rateLimit") return
        const { remaining, limit, resetsAt } = event.rateLimit
        const time = new Date(resetsAt).toLocaleTimeString(getLocale(), { hour: "numeric", minute: "2-digit" })
        const text =
          event.level === "low"
            ? m.github_rate_limit_low({ remaining, limit, time })
            : m.github_rate_limit_exhausted({ time })
        // One id, so running out replaces the low budget warning instead of stacking under it.
        toast.warning(text, { id: "github-rate-limit", duration: 10_000 })
      }),
    [],
  )
}
