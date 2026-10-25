import { Effect, Schema } from "effect"

const LimitReset = Schema.NullOr(Schema.Struct({ at: Schema.String, autoResume: Schema.Boolean }))

/** An org spend limit carries the session reset too: an admin may raise the limit before then. */
export const UsageLimit = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("usage"), message: Schema.String, reset: LimitReset }),
  Schema.Struct({
    kind: Schema.Literal("org_spend"),
    message: Schema.String,
    reset: LimitReset.pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  }),
])
export type UsageLimit = typeof UsageLimit.Type

/** A plan allowance window. `model` is a per-model weekly bucket; `minutes` is any other length Codex reports. */
export const LimitWindowKind = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("session") }),
  Schema.Struct({ kind: Schema.Literal("weekly") }),
  Schema.Struct({ kind: Schema.Literal("model"), name: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("minutes"), minutes: Schema.Number }),
])
export type LimitWindowKind = typeof LimitWindowKind.Type

export const LimitWindow = Schema.Struct({
  window: LimitWindowKind,
  /** 0 to 100. */
  usedPercent: Schema.Number,
  resetsAt: Schema.NullOr(Schema.String),
})
export type LimitWindow = typeof LimitWindow.Type

export const PlanLimits = Schema.Struct({ windows: Schema.Array(LimitWindow), readAt: Schema.String })
export type PlanLimits = typeof PlanLimits.Type

export const limitLevel = (usedPercent: number) =>
  usedPercent >= 100 ? "exhausted" : usedPercent >= 80 ? "warning" : "normal"

export const mostUsed = (windows: ReadonlyArray<LimitWindow>) =>
  windows.reduce<LimitWindow | undefined>(
    (top, window) => (top === undefined || window.usedPercent > top.usedPercent ? window : top),
    undefined,
  )

const blocks = (window: LimitWindow, model: string) =>
  limitLevel(window.usedPercent) === "exhausted" &&
  (window.window.kind !== "model" || model.toLowerCase().includes(window.window.name.toLowerCase()))

const resetMs = (window: LimitWindow) => (window.resetsAt === null ? Infinity : Date.parse(window.resetsAt))

/**
 * The spent window that keeps an account from running `model`, the one that resets last. A per-model window
 * counts only for models whose id contains its name, such as "Fable" for `claude-fable-5-1`.
 */
export const spentWindow = (windows: ReadonlyArray<LimitWindow>, model: string) =>
  windows
    .filter((window) => blocks(window, model))
    .reduce<LimitWindow | undefined>(
      (last, window) => (last === undefined || resetMs(window) > resetMs(last) ? window : last),
      undefined,
    )

export interface AccountRoom {
  /** Undefined when the plan limits are unknown, such as for an API key. */
  readonly mostUsed: LimitWindow | undefined
  /** The window that keeps the account from running the thread's model. */
  readonly spent: LimitWindow | undefined
}

export const accountRoom = (windows: ReadonlyArray<LimitWindow>, model: string): AccountRoom => ({
  mostUsed: mostUsed(windows),
  spent: spentWindow(windows, model),
})

/** The account with known limits, nothing spent and the least used, or undefined when none has room. */
export const roomiest = <A extends AccountRoom>(accounts: ReadonlyArray<A>) =>
  accounts
    .filter((account) => account.mostUsed !== undefined && account.spent === undefined)
    .reduce<A | undefined>(
      (least, account) =>
        least === undefined || account.mostUsed!.usedPercent < least.mostUsed!.usedPercent ? account : least,
      undefined,
    )
