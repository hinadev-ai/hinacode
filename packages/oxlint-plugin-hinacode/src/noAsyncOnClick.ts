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
    const localFunction = (identifier: ESTree.Node): Handler | undefined => {
      if (identifier.type !== "Identifier") return undefined
      const variable = resolve(context.sourceCode.getScope(identifier), identifier.name)
      for (const { node } of variable?.defs ?? []) {
        if (node.type === "FunctionDeclaration") return node
        if (node.type === "VariableDeclarator" && node.init && isFunction(node.init)) return node.init
      }
      return undefined
    }

    const callsAsyncLocal = (expression: ESTree.Node) =>
      expression.type === "CallExpression" && !!localFunction(expression.callee)?.async

    const startsAsyncWork = (handler: ESTree.Node): boolean => {
      const handlerFunction = isFunction(handler) ? handler : localFunction(handler)
      if (!handlerFunction) return false
      if (handlerFunction.async) return true
      return statementsOf(handlerFunction).some(
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
