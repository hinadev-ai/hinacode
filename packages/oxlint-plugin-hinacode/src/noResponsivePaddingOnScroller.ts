import { defineRule } from "@oxlint/plugins"
import { classNameVisitor, splitTopLevel, utilityOf } from "./classNames.ts"

const SCROLLS = /^overflow(-[xy])?-(auto|scroll)$/
const PADDING = /^p[xytrblse]?-/
const SIZE_VARIANT = /^(@|(not-)?((max|min)-)?(sm|md|lg|xl|2xl)$|(not-)?(max|min)-\[|\[@media)/
const TARGETS_CHILDREN = /^(\[&|\*)/

const isResponsivePadding = (token: string) => {
  const parts = splitTopLevel(token)
  const utility = parts.at(-1) ?? ""
  const variants = parts.slice(0, -1)
  return (
    PADDING.test(utility) &&
    variants.some((variant) => SIZE_VARIANT.test(variant)) &&
    !variants.some((variant) => TARGETS_CHILDREN.test(variant))
  )
}

export const noResponsivePaddingOnScroller = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Disallow padding that changes with size on a scroll container." },
    messages: {
      responsivePadding:
        "`{{utility}}` resizes the padding of a scroll container, which moves its content and scrollbar as the space changes. Keep the scroller full width and move or hide what does not fit.",
    },
  },
  create(context) {
    return classNameVisitor((attribute, tokens) => {
      if (!tokens.some((token) => SCROLLS.test(utilityOf(token)))) return
      for (const utility of tokens.filter(isResponsivePadding))
        context.report({ node: attribute, messageId: "responsivePadding", data: { utility } })
    })
  },
})
