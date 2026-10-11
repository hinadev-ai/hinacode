import { useAtomSuspense } from "@effect/atom-react"
import { settingsAtom } from "./rpc.ts"

/** Current settings. Never suspends in practice: main.tsx loads them before the first render. */
export const useSettings = () => useAtomSuspense(settingsAtom).value
