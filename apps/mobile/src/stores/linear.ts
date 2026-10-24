import type { LinearIssue } from "@shared/domain.ts"
import { create } from "zustand"
import { call, RpcError } from "@/lib/connection"
import { copy } from "@/lib/copy"
import { errorText } from "@/lib/error-text"
import { sortIssues } from "@/lib/overview"
import type { Remote } from "@/stores/pull-requests"

/** Each read is a Linear API call on the server, so the list is read at most this often unless forced. */
const ISSUES_MAX_AGE = 60_000

/** A desktop from before Linear tickets answers the method as unknown, which its schema check reports. */
const failureText = (cause: unknown) =>
  cause instanceof RpcError && cause.tag === "SchemaError"
    ? copy("mobile_overview_linear_update_desktop")
    : copy("mobile_overview_linear_failed", { message: errorText(cause) })

interface LinearState {
  /** Undefined until the first read. */
  readonly issues: Remote<readonly LinearIssue[]> | undefined
  /** Whether the server has a Linear key, so an empty list can say why. Null when unknown. */
  readonly configured: boolean | null
  readonly load: (options?: { readonly force?: boolean }) => Promise<void>
}

export const useLinear = create<LinearState>()((set, get) => {
  let inflight: Promise<void> | null = null

  const read = async () => {
    if (get().issues === undefined) set({ issues: { status: "loading" } })
    const [issues, configured] = await Promise.allSettled([
      call("linear.issues", undefined),
      call("secrets.has", { name: "linear.apiKey" }),
    ])
    const at = Date.now()
    set({
      issues:
        issues.status === "fulfilled"
          ? { status: "ready", value: sortIssues(issues.value), at }
          : { status: "error", message: failureText(issues.reason), at },
      configured: configured.status === "fulfilled" ? configured.value : null,
    })
  }

  return {
    issues: undefined,
    configured: null,
    load: (options) => {
      if (inflight !== null) return inflight
      const current = get().issues
      if (options?.force !== true && current?.status === "ready" && Date.now() - current.at < ISSUES_MAX_AGE) {
        return Promise.resolve()
      }
      inflight = read().finally(() => {
        inflight = null
      })
      return inflight
    },
  }
})
