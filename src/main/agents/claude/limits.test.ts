import { describe, expect, it } from "@effect/vitest"
import { toPlanLimits } from "./limits.ts"

const readAt = "2026-10-12T10:00:00.000Z"
const window = (utilization: number | null, resets_at: string | null) => ({
  utilization,
  resets_at,
  limit_dollars: null,
  used_dollars: null,
  remaining_dollars: null,
  locked_reason: null,
})

const teamAnswer = {
  session: { total_cost_usd: 0 },
  subscription_type: "team",
  rate_limits_available: true,
  rate_limits: {
    five_hour: window(4, "2026-10-12T15:09:59.752920+00:00"),
    seven_day: window(66, "2026-10-14T16:59:59.752946+00:00"),
    seven_day_oauth_apps: null,
    seven_day_opus: null,
    seven_day_sonnet: null,
    amber_gauge: null,
    extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
    model_scoped: [{ display_name: "Fable", utilization: 56, resets_at: "2026-10-14T16:59:59.753204+00:00" }],
  },
  behaviors: null,
}

describe("toPlanLimits", () => {
  it("reads the session, weekly and per-model windows", () => {
    expect(toPlanLimits(teamAnswer, readAt)).toStrictEqual({
      windows: [
        { window: { kind: "session" }, usedPercent: 4, resetsAt: "2026-10-12T15:09:59.752920+00:00" },
        { window: { kind: "weekly" }, usedPercent: 66, resetsAt: "2026-10-14T16:59:59.752946+00:00" },
        {
          window: { kind: "model", name: "Fable" },
          usedPercent: 56,
          resetsAt: "2026-10-14T16:59:59.753204+00:00",
        },
      ],
      readAt,
    })
  })

  it("falls back to the fixed model windows without model_scoped and skips windows without utilization", () => {
    const { model_scoped: _, ...rateLimits } = teamAnswer.rate_limits
    const answer = {
      ...teamAnswer,
      rate_limits: { ...rateLimits, five_hour: window(null, null), seven_day_opus: window(12, null) },
    }
    expect(toPlanLimits(answer, readAt)?.windows.map((limit) => limit.window)).toStrictEqual([
      { kind: "weekly" },
      { kind: "model", name: "Opus" },
    ])
  })

  it("is null when limits do not apply or the answer changed shape", () => {
    expect(toPlanLimits({ ...teamAnswer, rate_limits_available: false, rate_limits: null }, readAt)).toBeNull()
    expect(toPlanLimits({ rate_limits: "soon" }, readAt)).toBeNull()
  })
})
