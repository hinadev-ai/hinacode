import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"

const root = join(import.meta.dirname, "..")
const from = join(root, "src/renderer/components/icons")
const to = join(root, "packages/icons/src")
const stays = new Set(["Icon.tsx", "SendGlyph.tsx", "EffortIcon.tsx", "LinearIcon.tsx", "OpencodeLogoIcon.tsx"])
const elements = { path: "Path", circle: "Circle", rect: "Rect", g: "G", mask: "Mask" } as const

const toPrimitives = (source: string) => {
  let body = source
    .replace(/^import \{ Icon, type IconProps \} from "\.\/Icon\.tsx"\n/m, "")
    .replace(/<Icon\b/g, "<Svg")
    .replace(/<\/Icon>/g, "</Svg>")
    .replace(/fill="var\(--sun, currentColor\)"/g, "fill={sun}")
  const used = ["Svg"]
  for (const [element, primitive] of Object.entries(elements)) {
    const tag = new RegExp(`<(/?)${element}\\b`, "g")
    if (!tag.test(body)) continue
    body = body.replace(tag, `<$1${primitive}`)
    used.push(primitive)
  }
  if (body.includes("fill={sun}")) used.push("sun")
  const primitivesImport = `import { ${[...used.toSorted((a, b) => a.localeCompare(b)), "type IconProps"].join(", ")} } from "./primitives"\n`
  const reactImport = /^import \{ useId \} from "react"\n\n?/m
  return reactImport.test(body)
    ? body.replace(reactImport, `import { useId } from "react"\n\n${primitivesImport}`)
    : primitivesImport + body
}

const candidates = execFileSync(
  "git",
  ["grep", "-l", "-E", 'icons/[A-Za-z]+\\.tsx"|"\\./Icon\\.tsx"', "--", "src", "site/src"],
  {
    cwd: root,
    encoding: "utf8",
  },
)
  .split("\n")
  .filter(Boolean)
const moved = readdirSync(from).filter((file) => file.endsWith(".tsx") && !stays.has(file))
const exportsOf = (source: string) =>
  [...source.matchAll(/^export (?:function|const) (\w+)/gm)].map(([, name]) => name!)

const index: string[] = [
  `export { Circle, G, Mask, Path, Rect, Svg as Icon, Svg, iconAttributes, sun, type IconComponent, type IconProps } from "./primitives"`,
]
const movedModules = new Set(["Icon"])
for (const file of moved) {
  const source = toPrimitives(readFileSync(join(from, file), "utf8"))
  writeFileSync(join(to, file), source)
  rmSync(join(from, file))
  movedModules.add(basename(file, ".tsx"))
  index.push(`export { ${exportsOf(source).join(", ")} } from "./${file}"`)
}
rmSync(join(from, "Icon.tsx"))
writeFileSync(join(to, "index.ts"), `${index.join("\n")}\n`)

const statement = /^(import|export)( type)? \{([^}]*)\} from "((?:\.{1,2}\/)+(?:[\w-]+\/)*?(\w+)\.tsx)"\n/gm

const withoutType = (name: string) => name.replace(/^type /, "")
const sorted = (names: Set<string>) =>
  [...names].toSorted((a, b) => withoutType(a).localeCompare(withoutType(b))).join(", ")

const rewrite = (file: string) => {
  const source = readFileSync(file, "utf8")
  const specifiers = { import: new Set<string>(), export: new Set<string>() }
  let at = -1
  const nextToIcons = file.startsWith(from)
  const next = source.replace(
    statement,
    (line, kind: "import" | "export", typeOnly, names: string, path: string, module) => {
      if (!movedModules.has(module) || !(nextToIcons || path.includes("/icons/"))) return line
      if (at < 0) at = source.indexOf(line)
      for (const name of names.split(",").map((part) => part.trim())) {
        if (name !== "") specifiers[kind].add(typeOnly && !name.startsWith("type ") ? `type ${name}` : name)
      }
      return ""
    },
  )
  if (at < 0) return false
  const lines = (["import", "export"] as const)
    .filter((kind) => specifiers[kind].size > 0)
    .map((kind) => {
      const names = [...specifiers[kind]]
      const allTypes = names.every((name) => name.startsWith("type "))
      const list = allTypes ? sorted(new Set(names.map((name) => name.slice(5)))) : sorted(specifiers[kind])
      return `${kind}${allTypes ? " type" : ""} { ${list} } from "@hinacode/icons"\n`
    })
  writeFileSync(file, next.slice(0, at) + lines.join("") + next.slice(at))
  return true
}

const rewritten = candidates.filter((file) => existsSync(join(root, file)) && rewrite(join(root, file)))
execFileSync("pnpm", ["exec", "oxfmt", to, ...rewritten.filter((file) => !file.endsWith(".astro"))], { cwd: root })
console.log(`moved ${moved.length} icons, rewrote imports in ${rewritten.length} files`)
