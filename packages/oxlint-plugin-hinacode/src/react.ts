import type { Context, ESTree, Variable } from "@oxlint/plugins"

export type Identifier = Extract<ESTree.Node, { type: "Identifier" }>

export const STATE_HOOKS = new Set(["useState", "useReducer", "useActionState", "useOptimistic"])

type Reference = { api: string; node: Identifier | ESTree.MemberExpression }

export function reactReferences(context: Context, declaration: ESTree.ImportDeclaration): Reference[] {
  if (declaration.source.value !== "react") return []
  return declaration.specifiers.flatMap((specifier) =>
    context.sourceCode.getDeclaredVariables(specifier).flatMap((variable) =>
      variable.references.flatMap(({ identifier }): Reference[] => {
        if (specifier.type === "ImportSpecifier") return [{ api: exportName(specifier.imported), node: identifier }]
        const member = identifier.parent
        if (member.type !== "MemberExpression" || member.computed || member.object !== identifier) return []
        return [{ api: exportName(member.property), node: member }]
      }),
    ),
  )
}

export function isCallee(node: ESTree.Node): boolean {
  return node.parent?.type === "CallExpression" && node.parent.callee === node
}

function exportName(node: ESTree.Node): string {
  if (node.type === "Identifier") return node.name
  if (node.type === "Literal") return String(node.value)
  return ""
}

export function secondBinding(sourceCode: Context["sourceCode"], call: ESTree.Node): Variable | undefined {
  const declarator = call.parent
  if (declarator?.type !== "VariableDeclarator" || declarator.id.type !== "ArrayPattern") return undefined
  const element = declarator.id.elements[1]
  if (element?.type !== "Identifier") return undefined
  return sourceCode.getDeclaredVariables(declarator).find((variable) => variable.name === element.name)
}

export function isFunction(node: ESTree.Node): node is ESTree.Function | ESTree.ArrowFunctionExpression {
  return (
    node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression" || node.type === "FunctionDeclaration"
  )
}
