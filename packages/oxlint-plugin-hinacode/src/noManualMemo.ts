import { defineRule } from "@oxlint/plugins"
import { isCallee, reactReferences } from "./react.ts"

const MANUAL_MEMO = new Set(["useMemo", "useCallback", "memo"])

export const noManualMemo = defineRule({
  meta: {
    type: "suggestion",
    docs: { description: "Disallow useMemo, useCallback and memo, which the React Compiler already does." },
    messages: { manualMemo: "The React Compiler already memoizes this. Remove `{{api}}`." },
  },
  create(context) {
    return {
      ImportDeclaration(declaration) {
        for (const { api, node } of reactReferences(context, declaration)) {
          if (MANUAL_MEMO.has(api) && isCallee(node)) {
            context.report({ node: node.parent, messageId: "manualMemo", data: { api } })
          }
        }
      },
    }
  },
})
