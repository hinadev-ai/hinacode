/**
 * Writes the Swift mirror of the rpc contract the iOS app speaks, from the same Effect schemas the desktop decodes
 * with, so the two cannot drift. Run `node scripts/swift-contract.ts` after changing `src/shared`, and commit the
 * result. `--check` fails when the committed file is stale.
 *
 * Only the methods in `methods` and the pushes in `pushes` are emitted, with every type they reach. Types follow the
 * encoded (wire) side of each schema. Unions and literals reached from an answer or a push decode unknown members
 * as `.unknown`, because a store build lags behind the desktop it talks to.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { Schema, SchemaAST as AST } from "effect"
import * as agent from "../src/shared/agent.ts"
import { methodKind, PushEvent, type RpcMethod, RpcMethods } from "../src/shared/contract.ts"
import * as domain from "../src/shared/domain.ts"
import * as github from "../src/shared/github.ts"
import * as relayMachines from "../src/shared/relayMachines.ts"
import { routes } from "../src/shared/routes.ts"

const OUTPUT = new URL("../apps/ios/HinaCodeKit/Sources/HinaCodeKit/Contract.swift", import.meta.url)

const methods: readonly RpcMethod[] = [
  "approvals.respond",
  "commands.list",
  "files.list",
  "fs.list",
  "fs.preview",
  "fs.read",
  "github.close",
  "github.merge",
  "github.pullRequest",
  "github.pullRequestDetail",
  "github.pullRequestFiles",
  "linear.issues",
  "models.list",
  "projects.branches",
  "projects.create",
  "projects.currentBranch",
  "projects.defaultBranch",
  "projects.fetch",
  "projects.icon",
  "projects.list",
  "projects.pullRequests",
  "pullRequestGuides.get",
  "pullRequestGuides.retry",
  "pullRequests.all",
  "pullRequests.create",
  "pullRequests.list",
  "pullRequests.unwatch",
  "pullRequests.watch",
  "questions.respond",
  "search.files",
  "search.threads",
  "secrets.has",
  "settings.get",
  "settings.set",
  "terminal.attach",
  "terminal.close",
  "terminal.open",
  "terminal.resize",
  "terminal.write",
  "threads.archive",
  "threads.create",
  "threads.interrupt",
  "threads.list",
  "threads.send",
  "threads.steer",
  "threads.transcript",
  "threads.unarchive",
  "threads.update",
  "worktrees.list",
  "worktrees.pullRequest",
]

/** The pushes the app reacts to. Every other one decodes as `PushEvent.unknown`. */
const pushes: ReadonlySet<string> = new Set([
  "message.created",
  "message.updated",
  "pullRequest.guide",
  "terminal.data",
  "terminal.exited",
  "thread.event",
  "thread.pullRequests",
  "thread.removed",
  "thread.updated",
  "worktree.updated",
])

/** Exported names that collide with Foundation or SwiftUI. */
const renames: Record<string, string> = { Thread: "AgentThread", Environment: "HinaEnvironment" }

type SwiftType =
  | { readonly kind: "primitive"; readonly name: "String" | "Double" | "Int" | "Bool" | "JSONValue" }
  | { readonly kind: "array"; readonly element: SwiftType }
  | { readonly kind: "dictionary"; readonly value: SwiftType }
  | { readonly kind: "named"; readonly name: string }

interface Field {
  readonly key: string
  readonly name: string
  readonly type: SwiftType
  /** The key may be absent. */
  readonly optionalKey: boolean
  /** The value may be null. */
  readonly nullable: boolean
}

type Decl =
  | { readonly kind: "struct"; readonly name: string; readonly fields: readonly Field[] }
  | { readonly kind: "literals"; readonly name: string; readonly values: readonly string[]; readonly lenient: boolean }
  | {
      readonly kind: "tagged"
      readonly name: string
      readonly tag: string
      readonly cases: readonly { readonly value: string; readonly payload: string }[]
      readonly lenient: boolean
    }
  | { readonly kind: "untagged"; readonly name: string; readonly cases: readonly SwiftType[] }

/**
 * The wire shape of one node. `AST.toEncoded` rebuilds the whole subtree, which loses the identity of the named
 * schemas inside it, so a node is only replaced when it transforms itself and its children are read one by one.
 */
const wire = (ast: AST.AST) => (ast.encoding === undefined ? ast : AST.toEncoded(ast))

const names = new Map<AST.AST, string>()
for (const module of [domain, agent, github, relayMachines]) {
  for (const [name, value] of Object.entries(module)) {
    if (!AST.isAST((value as { readonly ast?: unknown }).ast)) continue
    const ast = wire((value as { readonly ast: AST.AST }).ast)
    // A primitive's node is shared by every schema of that primitive, so naming it would name them all.
    if (ast._tag === "Objects" || ast._tag === "Union" || ast._tag === "Literal")
      if (!names.has(ast)) names.set(ast, renames[name] ?? name)
  }
}

const decls = new Map<string, Decl>()
const declared = new Map<AST.AST, string>()
/** Whether the types being declared are reached from an answer or a push, so they must accept the unknown. */
let decoding = true

const pascal = (text: string) =>
  text
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join("")

const camel = (text: string) => {
  const name = pascal(text)
  const lowered = name.replace(/^[A-Z]+(?=[A-Z][a-z]|$)|^[A-Z]/, (head) => head.toLowerCase())
  return /^[0-9]/.test(lowered) ? `_${lowered}` : lowered
}

const singular = (name: string) =>
  name.endsWith("ies") ? `${name.slice(0, -3)}y` : name.endsWith("s") && !name.endsWith("ss") ? name.slice(0, -1) : name

const reserved = new Set(
  "associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private precedencegroup protocol public rethrows static struct subscript typealias var break case catch continue default defer do else fallthrough for guard if in repeat return throw switch where while as Any await false is nil self Self super throws true try".split(
    " ",
  ),
)
const identifier = (name: string) => (reserved.has(name) ? `\`${name}\`` : name)

const isInt = (ast: AST.AST) =>
  ast.checks?.some(
    (check) => (check.annotations?.representation as { id?: string } | undefined)?.id === "effect/schema/isInt",
  ) ?? false

const isAbsent = (ast: AST.AST) => ast._tag === "Undefined" || ast._tag === "Void"

const fail = (message: string): never => {
  throw new Error(message)
}

/** Strips `Undefined` and `Null` members off `ast`, keeping the node itself when nothing was stripped. */
function unwrap(input: AST.AST): { readonly ast: AST.AST; readonly optional: boolean; readonly nullable: boolean } {
  let ast = wire(input)
  let optional = false
  let nullable = false
  while (ast._tag === "Union") {
    const members = ast.types.map(wire)
    const rest = members.filter((member) => !isAbsent(member) && member._tag !== "Null")
    if (rest.length === members.length) break
    optional ||= members.some(isAbsent)
    nullable ||= members.some((member) => member._tag === "Null")
    if (rest.length !== 1) fail(`Union with several members besides null or undefined: ${String(ast)}`)
    ast = rest[0]!
  }
  return { ast, optional, nullable }
}

function typeOf(input: AST.AST, hint: string): SwiftType {
  const ast = wire(input)
  switch (ast._tag) {
    case "String":
      return { kind: "primitive", name: "String" }
    case "Number":
      return { kind: "primitive", name: isInt(ast) ? "Int" : "Double" }
    case "Boolean":
      return { kind: "primitive", name: "Bool" }
    case "Unknown":
    case "Any":
      return { kind: "primitive", name: "JSONValue" }
    case "Arrays": {
      const [element, ...more] = [...ast.elements, ...ast.rest].map(wire)
      // NonEmptyArray encodes as `[head, ...rest]` with the same element schema twice.
      if (element === undefined || more.some((other) => other !== element) || ast.rest.length !== 1)
        return fail(`Unsupported tuple at ${hint}`)
      return { kind: "array", element: typeOf(element, singular(hint)) }
    }
    case "Objects":
      if (ast.propertySignatures.length === 0 && ast.indexSignatures.length === 1)
        return { kind: "dictionary", value: typeOf(ast.indexSignatures[0]!.type, `${hint}Value`) }
      return { kind: "named", name: declare(ast, hint) }
    case "Literal":
      return { kind: "named", name: declare(ast, hint) }
    case "Union": {
      const { ast: inner, optional, nullable } = unwrap(ast)
      if (optional || nullable) return fail(`Nullable type outside a field at ${hint}`)
      return { kind: "named", name: declare(inner, hint) }
    }
    default:
      return fail(`Unsupported ${ast._tag} at ${hint}`)
  }
}

const literalValue = (ast: AST.AST) =>
  ast._tag === "Literal" && typeof ast.literal === "string" ? ast.literal : undefined

/** The key every member of a union of objects holds a distinct string literal at, if there is one. */
function discriminator(members: readonly AST.AST[]): string | undefined {
  if (!members.every((member) => member._tag === "Objects")) return undefined
  const objects = members as readonly AST.Objects[]
  const candidates = objects[0]!.propertySignatures.map((property) => String(property.name))
  const tags = candidates.filter((key) => {
    const values = objects.map((object) => {
      const property = object.propertySignatures.find((p) => p.name === key)
      return property === undefined ? undefined : literalValue(wire(property.type))
    })
    return values.every((value) => value !== undefined) && new Set(values).size === values.length
  })
  return ["type", "_tag", "kind"].find((key) => tags.includes(key)) ?? tags[0]
}

function declare(ast: AST.AST, hint: string): string {
  const existing = declared.get(ast)
  if (existing !== undefined) return existing
  const name = names.get(ast) ?? hint
  if (decls.has(name)) fail(`Two types are both named ${name}`)
  declared.set(ast, name)
  decls.set(name, { kind: "struct", name, fields: [] })
  decls.set(name, build(ast, name))
  return name
}

function build(ast: AST.AST, name: string): Decl {
  switch (ast._tag) {
    case "Objects":
      return { kind: "struct", name, fields: fields(ast, name, undefined) }
    case "Literal": {
      const value = literalValue(ast) ?? fail(`Non-string literal ${name}`)
      return { kind: "literals", name, values: [value], lenient: decoding }
    }
    case "Union": {
      const members = ast.types.map(wire)
      const values = members.map(literalValue)
      if (values.every((value) => value !== undefined))
        return { kind: "literals", name, values: values as string[], lenient: decoding }
      const tag = discriminator(members)
      if (tag === undefined)
        return { kind: "untagged", name, cases: members.map((member, i) => typeOf(member, `${name}.Option${i + 1}`)) }
      const cases = (members as AST.Objects[]).map((member) => {
        const value = literalValue(wire(member.propertySignatures.find((p) => p.name === tag)!.type))!
        const payload = `${name}.${pascal(value)}`
        if (declared.has(member)) fail(`${payload} is also used outside its union`)
        declared.set(member, payload)
        decls.set(payload, { kind: "struct", name: payload, fields: fields(member, payload, tag) })
        return { value, payload }
      })
      return { kind: "tagged", name, tag, cases, lenient: decoding }
    }
    default:
      return fail(`Cannot declare ${ast._tag} as ${name}`)
  }
}

function fields(ast: AST.Objects, owner: string, skip: string | undefined): Field[] {
  if (ast.indexSignatures.length > 0) fail(`${owner} mixes properties and an index signature`)
  return ast.propertySignatures
    .filter((property) => property.name !== skip)
    .map((property) => {
      const key = String(property.name)
      const { ast: inner, optional, nullable } = unwrap(property.type)
      return {
        key,
        name: camel(key),
        type: typeOf(inner, `${owner}.${pascal(key)}`),
        optionalKey: optional || (property.type.context?.isOptional ?? false),
        nullable,
      }
    })
}

/** A method's payload or answer: `NoPayload` when it is void, else the type, declared under `fallback` if unnamed. */
function root(ast: AST.AST, fallback: string): string {
  const encoded = wire(ast)
  if (isAbsent(encoded)) return "NoPayload"
  const { ast: inner, nullable } = unwrap(encoded)
  return `${swift(typeOf(inner, fallback))}${nullable ? "?" : ""}`
}

/**
 * The Swift spelling of `type`. Inside a nested type, a sibling can shadow a top-level name (`MessagePart.Attachment`
 * holds an `Attachment`), so references from there are qualified with the module.
 */
const swift = (type: SwiftType, nested = false): string => {
  switch (type.kind) {
    case "primitive":
      return type.name
    case "array":
      return `[${swift(type.element, nested)}]`
    case "dictionary":
      return `[String: ${swift(type.value, nested)}]`
    case "named":
      return nested ? `HinaCodeKit.${type.name}` : type.name
  }
}

const fieldType = (field: Field, nested: boolean) => {
  const base = swift(field.type, nested)
  if (field.optionalKey && field.nullable) return `${base}??`
  return field.optionalKey || field.nullable ? `${base}?` : base
}

const leaf = (name: string) => name.slice(name.lastIndexOf(".") + 1)
const parent = (name: string) => (name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : undefined)

/** Wraps `body` in `extension Parent` for a nested name, so every declaration stays at the top level of the file. */
const scoped = (name: string, body: string) => {
  const outer = parent(name)
  return outer === undefined ? body : `extension ${outer} {\n${indent(body)}\n}`
}

const indent = (text: string) =>
  text
    .split("\n")
    .map((line) => (line === "" ? line : `    ${line}`))
    .join("\n")

/** Names for literals with no letters in them, such as a command's trigger. */
const symbols: Record<string, string> = { "": "empty", "/": "slash", $: "dollar", "@": "at", "#": "hash" }

const caseNames = (values: readonly string[]) => {
  const used = new Set<string>()
  return values.map((value) => {
    let name = camel(value) || (symbols[value] ?? fail(`No case name for the literal ${JSON.stringify(value)}`))
    while (used.has(name) || name === "unknown") name = `${name}_`
    used.add(name)
    return name
  })
}

function emitStruct(decl: Extract<Decl, { kind: "struct" }>) {
  const nested = parent(decl.name) !== undefined
  const conformances = ["Codable", "Hashable", "Sendable"]
  if (decl.fields.some((field) => field.key === "id" && !field.optionalKey && !field.nullable))
    conformances.push("Identifiable")
  const properties = decl.fields.map((field) => `public var ${identifier(field.name)}: ${fieldType(field, nested)}`)
  const parameters = decl.fields.map((field) => {
    const defaulted = field.optionalKey || field.nullable ? " = nil" : ""
    return `${identifier(field.name)}: ${fieldType(field, nested)}${defaulted}`
  })
  const assignments = decl.fields.map((field) => `self.${field.name} = ${identifier(field.name)}`)
  const keys = decl.fields.map((field) =>
    field.key === field.name ? `case ${identifier(field.name)}` : `case ${identifier(field.name)} = "${field.key}"`,
  )
  const decodes = decl.fields.map((field) => {
    const type = swift(field.type, nested)
    const key = `.${field.name}`
    if (field.optionalKey && field.nullable)
      return `${field.name} = container.contains(${key}) ? .some(try container.decodeIfPresent(${type}.self, forKey: ${key})) : nil`
    if (field.optionalKey || field.nullable)
      return `${field.name} = try container.decodeIfPresent(${type}.self, forKey: ${key})`
    return `${field.name} = try container.decode(${type}.self, forKey: ${key})`
  })
  const encodes = decl.fields.map((field) => {
    const key = `.${field.name}`
    if (field.optionalKey && field.nullable)
      return `if let ${identifier(field.name)} { try container.encode(${identifier(field.name)}, forKey: ${key}) }`
    if (field.optionalKey) return `try container.encodeIfPresent(${identifier(field.name)}, forKey: ${key})`
    return `try container.encode(${identifier(field.name)}, forKey: ${key})`
  })
  const body = [
    `public struct ${leaf(decl.name)}: ${conformances.join(", ")} {`,
    ...properties.map((line) => `    ${line}`),
    "",
    `    public init(${parameters.join(", ")}) {`,
    ...assignments.map((line) => `        ${line}`),
    "    }",
    ...(decl.fields.length === 0
      ? []
      : [
          "",
          `    private enum CodingKeys: String, CodingKey {`,
          ...keys.map((line) => `        ${line}`),
          "    }",
          "",
          "    public init(from decoder: any Decoder) throws {",
          "        let container = try decoder.container(keyedBy: CodingKeys.self)",
          ...decodes.map((line) => `        ${line}`),
          "    }",
          "",
          "    public func encode(to encoder: any Encoder) throws {",
          "        var container = encoder.container(keyedBy: CodingKeys.self)",
          ...encodes.map((line) => `        ${line}`),
          "    }",
        ]),
    "}",
  ]
  if (decl.fields.length === 0)
    body.splice(
      body.length - 1,
      0,
      "",
      "    public init(from decoder: any Decoder) throws {}",
      "",
      "    public func encode(to encoder: any Encoder) throws {",
      "        _ = encoder.container(keyedBy: NoKeys.self)",
      "    }",
    )
  return scoped(decl.name, body.join("\n"))
}

function emitLiterals(decl: Extract<Decl, { kind: "literals" }>) {
  const cases = caseNames(decl.values)
  const pairs = decl.values.map((value, i) => [value, cases[i]!] as const)
  const body = [
    `public enum ${leaf(decl.name)}: RawRepresentable, Codable, Hashable, Sendable${decl.lenient ? "" : ", CaseIterable"} {`,
    ...cases.map((name) => `    case ${identifier(name)}`),
    ...(decl.lenient ? ["    /// A value this build does not know yet.", "    case unknown(String)"] : []),
    "",
    ...(decl.lenient
      ? [
          `    public static let known: [Self] = [${cases.map((name) => `.${identifier(name)}`).join(", ")}]`,
          "",
          "    public init(rawValue: String) {",
          "        switch rawValue {",
          ...pairs.map(([value, name]) => `        case ${JSON.stringify(value)}: self = .${identifier(name)}`),
          "        default: self = .unknown(rawValue)",
          "        }",
          "    }",
        ]
      : [
          "    public init?(rawValue: String) {",
          "        switch rawValue {",
          ...pairs.map(([value, name]) => `        case ${JSON.stringify(value)}: self = .${identifier(name)}`),
          "        default: return nil",
          "        }",
          "    }",
        ]),
    "",
    "    public var rawValue: String {",
    "        switch self {",
    ...pairs.map(([value, name]) => `        case .${identifier(name)}: ${JSON.stringify(value)}`),
    ...(decl.lenient ? ["        case .unknown(let value): value"] : []),
    "        }",
    "    }",
    "}",
  ]
  return scoped(decl.name, body.join("\n"))
}

function emitTagged(decl: Extract<Decl, { kind: "tagged" }>) {
  const cases = caseNames(decl.cases.map((c) => c.value))
  const tagKey = identifier(camel(decl.tag))
  const body = [
    `public enum ${leaf(decl.name)}: Codable, Hashable, Sendable {`,
    ...decl.cases.map((c, i) => `    case ${identifier(cases[i]!)}(${leaf(c.payload)})`),
    ...(decl.lenient ? ["    /// A member this build does not know yet, by its tag.", "    case unknown(String)"] : []),
    "",
    "    private enum TagKey: String, CodingKey {",
    tagKey === decl.tag ? `        case ${tagKey}` : `        case ${tagKey} = "${decl.tag}"`,
    "    }",
    "",
    "    public init(from decoder: any Decoder) throws {",
    `        let tag = try decoder.container(keyedBy: TagKey.self).decode(String.self, forKey: .${camel(decl.tag)})`,
    "        switch tag {",
    ...decl.cases.map(
      (c, i) =>
        `        case ${JSON.stringify(c.value)}: self = .${identifier(cases[i]!)}(try ${leaf(c.payload)}(from: decoder))`,
    ),
    decl.lenient
      ? "        default: self = .unknown(tag)"
      : `        default: throw DecodingError.dataCorruptedError(forKey: .${camel(decl.tag)}, in: try decoder.container(keyedBy: TagKey.self), debugDescription: "Unknown tag \\(tag)")`,
    "        }",
    "    }",
    "",
    "    public func encode(to encoder: any Encoder) throws {",
    "        var container = encoder.container(keyedBy: TagKey.self)",
    "        switch self {",
    ...decl.cases.flatMap((c, i) => [
      `        case .${identifier(cases[i]!)}(let value):`,
      `            try container.encode(${JSON.stringify(c.value)}, forKey: .${camel(decl.tag)})`,
      "            try value.encode(to: encoder)",
    ]),
    ...(decl.lenient
      ? ["        case .unknown(let tag):", `            try container.encode(tag, forKey: .${camel(decl.tag)})`]
      : []),
    "        }",
    "    }",
    "}",
  ]
  return scoped(decl.name, body.join("\n"))
}

function emitUntagged(decl: Extract<Decl, { kind: "untagged" }>) {
  const nested = parent(decl.name) !== undefined
  const cases = decl.cases.map((_, i) => `option${i + 1}`)
  const body = [
    "/// Decoded as the first member that fits.",
    `public enum ${leaf(decl.name)}: Codable, Hashable, Sendable {`,
    ...decl.cases.map((type, i) => `    case ${cases[i]}(${swift(type, nested)})`),
    "",
    "    public init(from decoder: any Decoder) throws {",
    ...decl.cases.map(
      (type, i) =>
        `        if let value = try? ${swift(type, nested)}(from: decoder) { self = .${cases[i]}(value); return }`,
    ),
    `        throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "No member of ${decl.name} fits"))`,
    "    }",
    "",
    "    public func encode(to encoder: any Encoder) throws {",
    "        switch self {",
    ...cases.map((name) => `        case .${name}(let value): try value.encode(to: encoder)`),
    "        }",
    "    }",
    "}",
  ]
  return scoped(decl.name, body.join("\n"))
}

const emit = (decl: Decl) => {
  switch (decl.kind) {
    case "struct":
      return emitStruct(decl)
    case "literals":
      return emitLiterals(decl)
    case "tagged":
      return emitTagged(decl)
    case "untagged":
      return emitUntagged(decl)
  }
}

const routeLiteral = (method: RpcMethod) => {
  const route = routes[method]
  switch (route.to) {
    case "owner":
      return `.owner(.${route.entity}, key: "${route.key}")`
    case "client":
      return fail(`${method} only runs on the desktop`)
    default:
      return `.${route.to}`
  }
}

const listened = PushEvent.members.filter((member) => pushes.has(member.fields.type.literal))
root(Schema.Union(listened).ast, "PushEvent")
const answers = methods.map((method) => root(RpcMethods[method].response.ast, `${pascal(method)}Response`))
decoding = false
const payloads = methods.map((method) => root(RpcMethods[method].request.ast, `${pascal(method)}Request`))

const table = methods.map(
  (method, i) =>
    `    public static let ${camel(method)} = Method<${payloads[i]}, ${answers[i]}>("${method}", mutation: ${methodKind[method] === "mutation"}, route: ${routeLiteral(method)})`,
)

const source = [
  "// Generated by scripts/swift-contract.ts from src/shared. Do not edit.",
  "// swift-format-ignore-file",
  "",
  "import Foundation",
  "",
  "/// Every desktop method this app calls, with where it is routed when several servers are paired.",
  "public enum RPC {",
  ...table,
  "}",
  "",
  ...[...decls.values()].toSorted((a, b) => a.name.localeCompare(b.name)).map((decl) => `${emit(decl)}\n`),
].join("\n")

if (process.argv.includes("--check")) {
  if (readFileSync(OUTPUT, "utf8") !== source) {
    console.error("apps/ios contract is stale. Run `node scripts/swift-contract.ts` and commit the result.")
    process.exit(1)
  }
} else writeFileSync(OUTPUT, source)
