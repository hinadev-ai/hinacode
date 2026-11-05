import { definePlugin } from "@oxlint/plugins"
import { noAsyncOnClick } from "./noAsyncOnClick.ts"
import { noComments } from "./noComments.ts"
import { allergicToSparklingIcon } from "./allergicToSparklingIcon.ts"
import { noManualMemo } from "./noManualMemo.ts"
import { noPromiseStateInEffect } from "./noPromiseStateInEffect.ts"
import { noResponsivePaddingOnScroller } from "./noResponsivePaddingOnScroller.ts"
import { noWallClockInTest } from "./noWallClockInTest.ts"
import { preferStartTransition } from "./preferStartTransition.ts"

export default definePlugin({
  meta: { name: "hinacode" },
  rules: {
    "no-async-on-click": noAsyncOnClick,
    "no-comments": noComments,
    "allergic-to-sparkling-icon": allergicToSparklingIcon,
    "no-manual-memo": noManualMemo,
    "no-promise-state-in-effect": noPromiseStateInEffect,
    "no-responsive-padding-on-scroller": noResponsivePaddingOnScroller,
    "no-wall-clock-in-test": noWallClockInTest,
    "prefer-start-transition": preferStartTransition,
  },
})
