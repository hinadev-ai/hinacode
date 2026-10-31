import { defineRule, type ESTree } from "@oxlint/plugins"

const SCROLLS = /^overflow(-[xy])?-(auto|scroll)$/
const PADDING = /^p[xytrblse]?-/
const SIZE_VARIANT = /^(@|(not-)?((max|min)-)?(sm|md|lg|xl|2xl)$|(not-)?(max|min)-\[|\[@media)/
const TARGETS_CHILDREN = /^(\[&|\*)/

const splitTopLevel = (token: string) => {
  const parts: Array<string> = []
  let depth = 0
  let start = 0
  for (let index = 0; index < token.length; index++) {
    const char = token[index]
    if (char === "[" || char === "(") depth++
    else if (char === "]" || char === ")") depth--
    else if (char === ":" && depth === 0) {
      parts.push(token.slice(start, index))
      start = index + 1
    }
  }
  parts.push(token.slice(start))
  return parts
}

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

const isScroller = (token: string) => SCROLLS.test(splitTopLevel(token).at(-1) ?? "")

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
    const constants = new Map<string, string>()

    const strings = (node: ESTree.Node | null | undefined): Array<string> => {
      if (!node) return []
      switch (node.type) {
        case "Literal":
          return typeof node.value === "string" ? [node.value] : []
        case "TemplateLiteral":
          return [...node.quasis.map((quasi) => quasi.value.cooked ?? ""), ...node.expressions.flatMap(strings)]
        case "Identifier":
          return constants.has(node.name) ? [constants.get(node.name) ?? ""] : []
        case "JSXExpressionContainer":
          return node.expression.type === "JSXEmptyExpression" ? [] : strings(node.expression)
        case "CallExpression":
          return node.arguments.flatMap(strings)
        case "ArrayExpression":
          return node.elements.flatMap((element) => strings(element))
        case "LogicalExpression":
        case "BinaryExpression":
          return [...strings(node.left), ...strings(node.right)]
        case "ConditionalExpression":
          return [...strings(node.consequent), ...strings(node.alternate)]
        default:
          return []
      }
    }

    return {
      VariableDeclarator(declarator) {
        if (declarator.id.type !== "Identifier") return
        const [value] = strings(declarator.init)
        if (declarator.init?.type === "Literal" && value !== undefined) constants.set(declarator.id.name, value)
      },
      JSXAttribute(attribute) {
        if (attribute.name.type !== "JSXIdentifier" || attribute.name.name !== "className") return
        const tokens = strings(attribute.value).flatMap((value) => value.split(/\s+/).filter(Boolean))
        if (!tokens.some(isScroller)) return
        for (const utility of tokens.filter(isResponsivePadding))
          context.report({ node: attribute, messageId: "responsivePadding", data: { utility } })
      },
    }
  },
})
