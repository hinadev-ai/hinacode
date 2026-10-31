import { defineRule, type ESTree } from "@oxlint/plugins"

const SPARKLING = /Sparkl/

const isReactIcons = (source: string) => source === "react-icons" || source.startsWith("react-icons/")

const nameOf = (node: ESTree.Node) =>
  node.type === "Identifier" ? node.name : node.type === "Literal" ? String(node.value) : ""

export const allergicToSparklingIcon = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Disallow sparkling icons from react-icons." },
    messages: { sparkling: "`{{name}}` is a sparkling icon. Pick one that shows what the thing is or does." },
  },
  create(context) {
    const check = (names: ReadonlyArray<ESTree.Node>) => {
      for (const name of names)
        if (SPARKLING.test(nameOf(name)))
          context.report({ node: name, messageId: "sparkling", data: { name: nameOf(name) } })
    }
    return {
      ImportDeclaration(declaration) {
        if (!isReactIcons(String(declaration.source.value))) return
        check(
          declaration.specifiers.flatMap((specifier) =>
            specifier.type === "ImportSpecifier" ? [specifier.imported] : [],
          ),
        )
      },
      ExportNamedDeclaration(declaration) {
        if (declaration.source && isReactIcons(String(declaration.source.value)))
          check(declaration.specifiers.map((specifier) => specifier.local))
      },
    }
  },
})
