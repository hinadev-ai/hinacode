import { noResponsivePaddingOnScroller } from "./noResponsivePaddingOnScroller.ts"
import { ruleTester } from "./ruleTester.ts"

ruleTester.run("no-responsive-padding-on-scroller", noResponsivePaddingOnScroller, {
  valid: [
    `<div className="overflow-auto px-4 pe-3" />`,
    `<div className="@min-[48rem]:pe-70" />`,
    `<div className="overflow-hidden @min-[48rem]:pe-70" />`,
    `<div className="overflow-auto data-[open=true]:pe-4 hover:px-2" />`,
    `<div className="overflow-auto [&_.row]:@md:px-4" />`,
    `<div className="overflow-auto @md:gap-4 md:max-w-3xl" />`,
    `<div className={cn("overflow-auto", open && "pe-4")} />`,
  ],
  invalid: [
    {
      code: `<div className="flex overflow-auto @min-[48rem]:@max-[83rem]:pe-70" />`,
      errors: [{ messageId: "responsivePadding", data: { utility: "@min-[48rem]:@max-[83rem]:pe-70" } }],
    },
    { code: `<div className="overflow-y-scroll md:px-4" />`, errors: 1 },
    { code: `<div className="overflow-x-auto max-lg:p-2" />`, errors: 1 },
    { code: `<div className="overflow-auto @md/thread:pb-8 @lg:pt-2" />`, errors: 2 },
    {
      code: `const besideOverview = "@min-[48rem]:@max-[83rem]:pe-70";
<div className={cn("flex min-h-0 flex-1 flex-col overflow-auto", besideOverview)} />`,
      errors: 1,
    },
    { code: '<div className={`overflow-auto ${wide ? "@xl:ps-8" : ""}`} />', errors: 1 },
  ],
})
