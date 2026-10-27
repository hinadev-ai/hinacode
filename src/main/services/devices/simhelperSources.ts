import hid from "./simhelper/hid.swift?raw"
import main from "./simhelper/main.swift?raw"
import type { SimhelperSources } from "./ios.ts"

/** The helper ships as source and is compiled on the user's Mac, so the package carries no binary. */
export const simhelperSources: SimhelperSources = { "main.swift": main, "hid.swift": hid }
