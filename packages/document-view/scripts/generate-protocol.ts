import { writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { kotlinProtocol, PROTOCOL_FILES, swiftProtocol } from "../src/protocolSources.ts"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
writeFileSync(join(root, PROTOCOL_FILES.swift), swiftProtocol())
writeFileSync(join(root, PROTOCOL_FILES.kotlin), kotlinProtocol())
