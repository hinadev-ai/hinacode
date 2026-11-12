import { defineRule, type ESTree } from "@oxlint/plugins"
import { classNameVisitor, utilityOf } from "./classNames.ts"

const SCROLLS_WHEN_NEEDED = /^overflow(-y)?-auto$/
const DECIDES_GUTTER = /^scrollbar-(gutter-(auto|stable|both)|none)$/
const SCROLLER_COMPONENTS = new Set(["LegendList"])

const elementName = (element: ESTree.JSXOpeningElement) =>
  element.name.type === "JSXIdentifier" ? element.name.name : undefined

const isScrollerComponent = (node: ESTree.Node) =>
  node.type === "JSXOpeningElement" && SCROLLER_COMPONENTS.has(elementName(node) ?? "")

export const stableScrollbarGutter = defineRule({
  meta: {
    type: "suggestion",
    docs: { description: "Require a scroll container to decide where its scrollbar's space comes from." },
    messages: {
      shiftingScrollbar:
        "The scrollbar of this scroll container takes its width from the content when it appears, which shifts the layout. Add `scrollbar-gutter-stable`, `scrollbar-gutter-both` for centered content, or `scrollbar-gutter-auto` where the shift is fine.",
    },
  },
  create(context) {
    return {
      ...classNameVisitor((attribute, tokens) => {
        const utilities = tokens.map(utilityOf)
        const scrolls =
          isScrollerComponent(attribute.parent) || utilities.some((utility) => SCROLLS_WHEN_NEEDED.test(utility))
        if (scrolls && !utilities.some((utility) => DECIDES_GUTTER.test(utility)))
          context.report({ node: attribute, messageId: "shiftingScrollbar" })
      }),
      JSXOpeningElement(element: ESTree.JSXOpeningElement) {
        const hasClassName = element.attributes.some(
          (attribute) => attribute.type === "JSXAttribute" && attribute.name.name === "className",
        )
        if (isScrollerComponent(element) && !hasClassName)
          context.report({ node: element, messageId: "shiftingScrollbar" })
      },
    }
  },
})
