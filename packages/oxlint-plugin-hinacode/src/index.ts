import { definePlugin } from "@oxlint/plugins"
import { noComments } from "./noComments.ts"
import { allergicToSparklingIcon } from "./allergicToSparklingIcon.ts"
import { noManualMemo } from "./noManualMemo.ts"
import { noPromiseStateInEffect } from "./noPromiseStateInEffect.ts"
import { noWallClockInTest } from "./noWallClockInTest.ts"
import { preferStartTransition } from "./preferStartTransition.ts"

export default definePlugin({
  meta: { name: "hinacode" },
  rules: {
    "no-comments": noComments,
    "allergic-to-sparkling-icon": allergicToSparklingIcon,
    "no-manual-memo": noManualMemo,
    "no-promise-state-in-effect": noPromiseStateInEffect,
    "no-wall-clock-in-test": noWallClockInTest,
    "prefer-start-transition": preferStartTransition,
  },
})
