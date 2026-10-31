import { defineRule, type ESTree, type Variable } from "@oxlint/plugins"
import { isCallee, isFunction, reactReferences, secondBinding, STATE_HOOKS } from "./react.ts"

const EFFECT_HOOKS = new Set(["useEffect", "useLayoutEffect", "useInsertionEffect"])
const PROMISE_CALLBACKS = new Set(["then", "catch", "finally"])

export const noPromiseStateInEffect = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Disallow storing a promise result in state from an effect." },
    messages: {
      promiseState:
        "`{{setter}}` stores a promise result from an effect, so the component hand-rolls cancellation and caching. Load it with an atom or `use()` instead.",
    },
  },
  create(context) {
    const setters: Variable[] = []
    const effectCallbacks = new Set<ESTree.Node>()
    return {
      ImportDeclaration(declaration) {
        for (const { api, node } of reactReferences(context, declaration)) {
          if (!isCallee(node)) continue
          const call = node.parent as ESTree.CallExpression
          if (EFFECT_HOOKS.has(api) && call.arguments[0]) effectCallbacks.add(call.arguments[0])
          const setter = STATE_HOOKS.has(api) ? secondBinding(context.sourceCode, call) : undefined
          if (setter) setters.push(setter)
        }
      },
      "Program:exit"() {
        for (const setter of setters) {
          for (const { identifier, init } of setter.references) {
            if (!init && settlesInEffect(identifier, effectCallbacks)) {
              context.report({ node: identifier, messageId: "promiseState", data: { setter: setter.name } })
            }
          }
        }
      },
    }
  },
})

function settlesInEffect(setter: ESTree.Node, effectCallbacks: Set<ESTree.Node>): boolean {
  let settled = false
  let node: ESTree.Node = setter
  for (let parent = node.parent; parent; node = parent, parent = parent.parent) {
    if (effectCallbacks.has(node) && isFunction(node)) return settled
    if (
      parent.type === "CallExpression" &&
      parent.callee.type === "MemberExpression" &&
      parent.callee.property.type === "Identifier" &&
      PROMISE_CALLBACKS.has(parent.callee.property.name) &&
      parent.arguments.some((argument) => argument === node)
    ) {
      settled = true
    }
  }
  return false
}
