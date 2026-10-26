import { defineRule, type Context, type ESTree, type Variable } from "@oxlint/plugins"
import { type Identifier, isCallee, reactReferences } from "./react.ts"

const STATE_HOOKS = new Set(["useState", "useReducer", "useActionState", "useOptimistic"])
// Direct manipulation must render on the next frame: typing, pointing, dragging, focus, and a control
// showing its own new state, such as a menu opening or a checkbox ticking.
const URGENT_HANDLER =
  /^on(Change|Input|BeforeInput|Select|Key|Pointer|Mouse|Touch|Drag|Drop|Scroll|Wheel|Focus|Blur|Composition|Resize|Error|Load|Animation|Transition|ContextMenu|LostPointerCapture|GotPointerCapture|OpenChange|CheckedChange)/
// React's convention: a prop named `action` or ending in `Action` runs inside a transition.
const ACTION_PROP = /^(action|.+Action)$/

export const preferStartTransition = defineRule({
  meta: {
    type: "suggestion",
    docs: { description: "Prefer updating state from an event handler inside a transition." },
    messages: {
      outsideTransition:
        "`{{setter}}` updates state from `{{handler}}` outside a transition. Wrap it in startTransition, or hand it to a base component prop that does, such as Button `action` or Tabs `changeAction`.",
    },
  },
  create(context) {
    const setters: Variable[] = []
    const transitionStarters = new Set<ESTree.Node>()
    return {
      ImportDeclaration(declaration) {
        for (const { api, node } of reactReferences(context, declaration)) {
          if (api === "startTransition") transitionStarters.add(node)
          if (!isCallee(node)) continue
          const second = secondBinding(context.sourceCode, node.parent)
          if (!second) continue
          if (STATE_HOOKS.has(api)) setters.push(second)
          if (api === "useTransition")
            for (const { identifier } of second.references) transitionStarters.add(identifier)
        }
      },
      "Program:exit"() {
        for (const setter of setters) {
          for (const reference of setter.references) {
            if (reference.init) continue
            const handler = enclosingHandler(context.sourceCode, reference.identifier, transitionStarters)
            if (handler) {
              context.report({
                node: reference.identifier,
                messageId: "outsideTransition",
                data: { setter: setter.name, handler },
              })
            }
          }
        }
      },
    }
  },
})

/** The variable bound to `b` in `const [a, b] = hook()`. */
function secondBinding(sourceCode: Context["sourceCode"], call: ESTree.Node): Variable | undefined {
  const declarator = call.parent
  if (declarator?.type !== "VariableDeclarator" || declarator.id.type !== "ArrayPattern") return undefined
  const element = declarator.id.elements[1]
  if (element?.type !== "Identifier") return undefined
  return sourceCode.getDeclaredVariables(declarator).find((variable) => variable.name === element.name)
}

/** The name of the event prop that ends up calling `setter`, unless a transition wraps the call on the way. */
function enclosingHandler(
  sourceCode: Context["sourceCode"],
  setter: Identifier,
  transitionStarters: Set<ESTree.Node>,
): string | null {
  if (!isCallee(setter)) return handlerName(propOf(setter))
  let node: ESTree.Node = setter.parent
  for (let parent = node.parent; parent; node = parent, parent = parent.parent) {
    if (
      parent.type === "CallExpression" &&
      transitionStarters.has(parent.callee) &&
      parent.arguments.some((argument) => argument === node)
    ) {
      return null
    }
    if (!isFunction(parent)) continue
    const prop = propOf(parent)
    if (prop) return handlerName(prop)
    const binding = functionBinding(sourceCode, parent)
    if (binding) {
      return binding.references.map(({ identifier }) => handlerName(propOf(identifier))).find(Boolean) ?? null
    }
  }
  return null
}

function handlerName(prop: ESTree.JSXAttribute | null): string | null {
  if (prop?.name.type !== "JSXIdentifier") return null
  const name = prop.name.name
  return /^on[A-Z]/.test(name) && !URGENT_HANDLER.test(name) && !ACTION_PROP.test(name) ? name : null
}

function propOf(node: ESTree.Node): ESTree.JSXAttribute | null {
  const container = node.parent
  return container?.type === "JSXExpressionContainer" && container.parent.type === "JSXAttribute"
    ? container.parent
    : null
}

function isFunction(node: ESTree.Node): node is ESTree.Function | ESTree.ArrowFunctionExpression {
  return (
    node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression" || node.type === "FunctionDeclaration"
  )
}

function functionBinding(
  sourceCode: Context["sourceCode"],
  fn: ESTree.Function | ESTree.ArrowFunctionExpression,
): Variable | undefined {
  const declaration = fn.type === "FunctionDeclaration" ? fn : fn.parent
  const name =
    declaration.type === "FunctionDeclaration"
      ? declaration.id?.name
      : declaration.type === "VariableDeclarator" && declaration.id.type === "Identifier"
        ? declaration.id.name
        : undefined
  return name ? sourceCode.getDeclaredVariables(declaration).find((variable) => variable.name === name) : undefined
}
