import { defineRule, type ESTree, type Scope } from "@oxlint/plugins"
import { isFunction } from "./react.ts"

type Handler = ESTree.Function | ESTree.ArrowFunctionExpression

export const noAsyncOnClick = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Disallow starting async work from `onClick` without a pending state." },
    messages: {
      asyncOnClick:
        "`onClick` starts async work with no pending state, so each extra click runs it again. Pass it to Button `action`, which disables the button until the work settles, or track the pending state with useTransition.",
    },
  },
  create(context) {
    const isAsyncLocal = (identifier: ESTree.Node): boolean => {
      if (identifier.type !== "Identifier") return false
      const variable = resolve(context.sourceCode.getScope(identifier), identifier.name)
      return (
        variable?.defs.some(({ node }) => {
          if (node.type === "FunctionDeclaration") return node.async
          return node.type === "VariableDeclarator" && !!node.init && isFunction(node.init) && node.init.async
        }) ?? false
      )
    }

    const callsAsyncLocal = (expression: ESTree.Node) =>
      expression.type === "CallExpression" && isAsyncLocal(expression.callee)

    const startsAsyncWork = (handler: ESTree.Node): boolean => {
      if (!isFunction(handler)) return isAsyncLocal(handler)
      if (handler.async) return true
      return statementsOf(handler).some(
        (expression) =>
          (expression.type === "UnaryExpression" && expression.operator === "void") || callsAsyncLocal(expression),
      )
    }

    return {
      JSXAttribute(attribute) {
        if (attribute.name.type !== "JSXIdentifier" || attribute.name.name !== "onClick") return
        if (attribute.value?.type !== "JSXExpressionContainer") return
        if (attribute.parent.type !== "JSXOpeningElement" || elementName(attribute.parent.name).endsWith("MenuItem"))
          return
        const handler = attribute.value.expression
        if (startsAsyncWork(handler)) context.report({ node: attribute, messageId: "asyncOnClick" })
      },
    }
  },
})

function statementsOf(handler: Handler): ESTree.Node[] {
  const body = handler.body
  if (!body) return []
  if (body.type !== "BlockStatement") return [body]
  return body.body.flatMap((statement) => (statement.type === "ExpressionStatement" ? [statement.expression] : []))
}

function elementName(name: ESTree.JSXOpeningElement["name"]): string {
  if (name.type === "JSXIdentifier") return name.name
  if (name.type === "JSXMemberExpression") return name.property.name
  return name.name.name
}

function resolve(scope: Scope | null, name: string) {
  for (; scope; scope = scope.upper) {
    const variable = scope.set.get(name)
    if (variable) return variable
  }
  return undefined
}
