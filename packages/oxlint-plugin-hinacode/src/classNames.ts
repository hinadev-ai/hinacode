import type { ESTree } from "@oxlint/plugins"

export const splitTopLevel = (token: string) => {
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

export const utilityOf = (token: string) => splitTopLevel(token).at(-1) ?? ""

export const classNameVisitor = (onClassName: (attribute: ESTree.JSXAttribute, tokens: Array<string>) => void) => {
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
    VariableDeclarator(declarator: ESTree.VariableDeclarator) {
      if (declarator.id.type !== "Identifier") return
      const [value] = strings(declarator.init)
      if (declarator.init?.type === "Literal" && value !== undefined) constants.set(declarator.id.name, value)
    },
    JSXAttribute(attribute: ESTree.JSXAttribute) {
      if (attribute.name.type !== "JSXIdentifier" || attribute.name.name !== "className") return
      onClassName(
        attribute,
        strings(attribute.value).flatMap((value) => value.split(/\s+/).filter(Boolean)),
      )
    },
  }
}
