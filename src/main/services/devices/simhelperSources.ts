import hid from "./simhelper/hid.swift?raw"
import main from "./simhelper/main.swift?raw"
import type { SimhelperSources } from "./ios.ts"

export const simhelperSources: SimhelperSources = { "main.swift": main, "hid.swift": hid }
