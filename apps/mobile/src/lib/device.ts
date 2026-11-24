import { getRandomValues } from "expo-crypto"
import { Platform } from "react-native"

export const deviceName = Platform.OS === "ios" ? "iPhone" : Platform.OS === "android" ? "Android" : "Phone"

// FIXME: Hermes has no crypto.getRandomValues, and noble draws every key and nonce from it
export function provideRandomValues() {
  if (typeof globalThis.crypto?.getRandomValues === "function") return
  Object.defineProperty(globalThis, "crypto", {
    value: { ...globalThis.crypto, getRandomValues },
    configurable: true,
  })
}
