import { defineRule } from "@oxlint/plugins"

const DIRECTIVE =
  /^\s*(?:FIXME:|[ot]?x?lint-|eslint-|@ts-(?:expect-error|ignore|nocheck)|prettier-ignore|oxfmt-ignore|\/\s*<reference|[@#]__(?:PURE|NO_SIDE_EFFECTS)__|@vite-ignore|webpack[A-Z]|(?:c8|v8|istanbul) ignore|@jsxImportSource)/

export const noComments = defineRule({
  meta: {
    type: "suggestion",
    docs: { description: "Disallow comments other than tool directives and `FIXME:` workarounds." },
    messages: {
      comment:
        "Let the code speak. Mark a workaround with `FIXME:`, or disable `hinacode/no-comments` for a comment the code and docs cannot carry.",
    },
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (comment.type !== "Shebang" && !DIRECTIVE.test(comment.value.replace(/^\*+/, ""))) {
            context.report({ node: comment, messageId: "comment" })
          }
        }
      },
    }
  },
})
