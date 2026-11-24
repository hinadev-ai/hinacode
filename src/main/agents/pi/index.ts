import { Context, Layer } from "effect"
import type { AgentProvider } from "../provider.ts"
import { makePiProvider } from "./provider.ts"

export class PiProvider extends Context.Service<PiProvider, AgentProvider>()("hinacode/PiProvider") {
  static readonly layer = Layer.effect(PiProvider, makePiProvider)
}
