import { AtomRegistry } from "effect/reactivity"

/** The app's one atom registry, for code outside React such as push handlers and route hooks. */
export const registry = AtomRegistry.make()
