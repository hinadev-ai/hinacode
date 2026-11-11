import { readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "vitest"
import { kotlinProtocol, PROTOCOL_FILES, swiftProtocol } from "./protocolSources.ts"

const read = (path: string) => readFileSync(join(import.meta.dirname, "..", path), "utf8")

test("the Swift and Kotlin protocol files match src/protocol.ts; run `pnpm --dir packages/document-view protocol`", () => {
  expect(read(PROTOCOL_FILES.swift)).toBe(swiftProtocol())
  expect(read(PROTOCOL_FILES.kotlin)).toBe(kotlinProtocol())
})
