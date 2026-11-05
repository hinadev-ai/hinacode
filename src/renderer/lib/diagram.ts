import { Effect } from "effect"
import { Atom } from "effect/reactivity"
import { useDeferredValue } from "react"
import type { Appearance } from "../../shared/domain.ts"
import { familyOf } from "./rpc.ts"
import { useClientSettings } from "./settings.ts"
import { useDebouncedValue } from "./useDebouncedValue.ts"

// FIXME: Pele measures labels in this font to size nodes
const diagramFont = (uiFont: Appearance["uiFont"]) =>
  uiFont === null
    ? getComputedStyle(document.documentElement).getPropertyValue("--app-font-sans")
    : JSON.stringify(uiFont)

const RENDER_DELAY_MS = 250

export const diagramAtom = familyOf((code: string, uiFont: Appearance["uiFont"]) =>
  Atom.make(
    Effect.tryPromise({
      try: () =>
        import("pele/lazy").then(({ renderAsync }) =>
          renderAsync(code, { fontFamily: diagramFont(uiFont), fontSize: 12, links: false, images: false }),
        ),
      catch: (cause) => cause,
    }),
  ),
)

export function useSettledDiagram(code: string) {
  const { uiFont } = useClientSettings().appearance
  return { code: useDeferredValue(useDebouncedValue(code, RENDER_DELAY_MS)), uiFont }
}
