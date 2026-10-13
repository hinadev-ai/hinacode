import type { PlanLimits } from "../../../shared/limits.ts"
import type { SubscriptionUsage } from "./protocol.ts"

const SESSION_MINUTES = 5 * 60

const iso = (ms: number) => new Date(ms).toISOString()

export const toPlanLimits = ({ window, weekly, observedAtMs }: SubscriptionUsage): PlanLimits => ({
  windows: [
    {
      window:
        window.windowDurationMins === SESSION_MINUTES
          ? { kind: "session" }
          : { kind: "minutes", minutes: window.windowDurationMins },
      usedPercent: window.usedPercent,
      resetsAt: iso(window.resetsAtMs),
    },
    { window: { kind: "weekly" }, usedPercent: weekly.usedPercent, resetsAt: iso(weekly.resetsAtMs) },
  ],
  readAt: iso(observedAtMs),
})
