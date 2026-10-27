import { defineRule, type ESTree, type Scope } from "@oxlint/plugins"
import type { Identifier } from "./react.ts"

const TIMERS = new Set(["setTimeout", "setInterval", "setImmediate"])
const TIMER_MODULES = new Set(["timers", "node:timers", "timers/promises", "node:timers/promises"])

export const noWallClockInTest = defineRule({
  meta: {
    type: "problem",
    docs: { description: "Disallow reading or waiting on the wall clock in tests." },
    messages: {
      wallClock:
        "`{{call}}` depends on the wall clock. Advance Effect's TestClock, use a fixed timestamp, or wait on an event.",
    },
  },
  create(context) {
    const report = (node: ESTree.Node, call: string) => context.report({ node, messageId: "wallClock", data: { call } })
    return {
      ImportDeclaration(declaration) {
        if (TIMER_MODULES.has(String(declaration.source.value))) report(declaration, String(declaration.source.value))
      },
      CallExpression(call) {
        if (propertyName(call.callee) === "waitForTimeout") report(call, "waitForTimeout")
      },
      Identifier(identifier) {
        const call = wallClockCall(identifier)
        if (call && !isLocal(context.sourceCode.getScope(identifier), identifier.name)) report(identifier.parent, call)
      },
    }
  },
})

function wallClockCall(global: Identifier): string | null {
  const parent = global.parent
  if (parent.type === "MemberExpression" && parent.property === global) return null
  if (parent.type === "Property" && parent.key === global) return null
  const property = parent.type === "MemberExpression" && parent.object === global ? propertyName(parent) : null
  switch (global.name) {
    case "setTimeout":
    case "setInterval":
    case "setImmediate":
      return global.name
    case "globalThis":
      return property && TIMERS.has(property) ? `globalThis.${property}` : null
    case "Date":
      if (property === "now") return "Date.now"
      return parent.type === "NewExpression" && parent.arguments.length === 0 ? "new Date()" : null
    case "performance":
      return property === "now" ? "performance.now" : null
    case "process":
      return property === "hrtime" ? "process.hrtime" : null
    default:
      return null
  }
}

function propertyName(node: ESTree.Node): string | null {
  return node.type === "MemberExpression" && !node.computed && node.property.type === "Identifier"
    ? node.property.name
    : null
}

// oxlint's default env omits Node and DOM globals such as setTimeout, so `isGlobalReference` misses them.
function isLocal(scope: Scope | null, name: string): boolean {
  for (; scope && scope.type !== "global"; scope = scope.upper) if (scope.set.has(name)) return true
  return false
}
