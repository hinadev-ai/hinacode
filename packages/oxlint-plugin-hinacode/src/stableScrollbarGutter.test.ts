import { ruleTester } from "./ruleTester.ts"
import { stableScrollbarGutter } from "./stableScrollbarGutter.ts"

ruleTester.run("stable-scrollbar-gutter", stableScrollbarGutter, {
  valid: [
    `<div className="min-h-0 flex-1 overflow-y-auto scrollbar-gutter-stable" />`,
    `<div className="overflow-auto scrollbar-gutter-both" />`,
    `<div className="overflow-y-auto scrollbar-gutter-auto" />`,
    `<div className="overflow-y-auto scrollbar-none" />`,
    `<div className="overflow-y-scroll" />`,
    `<div className="overflow-x-auto" />`,
    `<div className="overflow-hidden" />`,
    `<LegendList data={rows} className="min-h-0 flex-1 scrollbar-gutter-stable" />`,
    `<div className={cn("overflow-y-auto", "scrollbar-gutter-stable")} />`,
  ],
  invalid: [
    { code: `<div className="min-h-0 flex-1 overflow-y-auto" />`, errors: [{ messageId: "shiftingScrollbar" }] },
    { code: `<pre className="max-h-80 overflow-auto p-2" />`, errors: 1 },
    { code: `<div className="@md:overflow-y-auto" />`, errors: 1 },
    { code: `<div className={cn("absolute inset-0", device && "overflow-auto p-3")} />`, errors: 1 },
    { code: `<LegendList data={rows} className="min-h-0 flex-1" />`, errors: 1 },
    { code: `<LegendList data={rows} />`, errors: 1 },
  ],
})
