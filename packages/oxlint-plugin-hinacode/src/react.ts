import type { Context, ESTree } from "@oxlint/plugins"

export type Identifier = Extract<ESTree.Node, { type: "Identifier" }>

type Reference = { api: string; node: Identifier | ESTree.MemberExpression }

/** Every place the file reads a React export, through a named, default or namespace import. */
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
