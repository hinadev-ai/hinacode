import type { KkcodeBridge } from "../shared/contract.ts"

declare global {
  interface Window {
    readonly kkcode: KkcodeBridge
  }
}
