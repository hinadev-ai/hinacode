import { definePlugin } from "@oxlint/plugins"
import { noManualMemo } from "./noManualMemo.ts"
import { noWallClockInTest } from "./noWallClockInTest.ts"
import { preferStartTransition } from "./preferStartTransition.ts"

export default definePlugin({
  meta: { name: "hinacode" },
  rules: {
    "no-manual-memo": noManualMemo,
    "no-wall-clock-in-test": noWallClockInTest,
    "prefer-start-transition": preferStartTransition,
  },
})
