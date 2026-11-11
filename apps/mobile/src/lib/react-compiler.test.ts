/// <reference types="node" />
import { transformSync } from "@babel/core"
import { globSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, it } from "vitest"

const sourceRoot = join(import.meta.dirname, "..")

const sourceFiles = globSync("**/*.{ts,tsx}", { cwd: sourceRoot }).filter(
  (file) => !/\.test\.tsx?$|\.d\.ts$/.test(file),
)

type CompilerEvent = { kind: string; detail?: { reason?: string; options?: { reason?: string } } }

const bailouts = (file: string) => {
  const events: CompilerEvent[] = []
  transformSync(readFileSync(join(sourceRoot, file), "utf8"), {
    cwd: sourceRoot,
    filename: file,
    babelrc: false,
    configFile: false,
    presets: [["@babel/preset-typescript", { isTSX: true, allExtensions: true }]],
    plugins: [
      ["babel-plugin-react-compiler", { logger: { logEvent: (_: string, event: CompilerEvent) => events.push(event) } }],
    ],
  })
  return events
    .filter((event) => event.kind === "CompileError" || event.kind === "PipelineError")
    .map((event) => `${event.kind}: ${event.detail?.reason ?? event.detail?.options?.reason ?? "unknown"}`)
}

it("finds the app's source files", () => {
  expect(sourceFiles.length).toBeGreaterThan(50)
})

const knownBailouts: Readonly<Record<string, readonly string[]>> = {
  "app/thread/[id]/document.tsx": ["CompileError: Cannot access refs during render"],
}

it.each(sourceFiles)("React Compiler compiles %s without bailing out", (file) => {
  expect(bailouts(file)).toEqual(knownBailouts[file] ?? [])
})
