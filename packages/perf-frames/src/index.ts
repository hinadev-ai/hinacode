import { requireNativeModule } from "expo"

export type PerfFrames = {
  start(): Promise<void>
  stop(): Promise<number[]>
}

export const loadPerfFrames = () => requireNativeModule<PerfFrames>("PerfFrames")
