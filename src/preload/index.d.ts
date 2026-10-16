import type { HinacodeBridge } from "../shared/contract.ts"

declare global {
  interface Window {
    readonly hinacode: HinacodeBridge
  }
}
