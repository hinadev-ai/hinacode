import * as SecureStore from "expo-secure-store"
import type { PairingTarget } from "@shared/remote.ts"
import { parseStoredTarget, STORAGE_KEY } from "./stored-target"

export const loadTarget = async () => parseStoredTarget(await SecureStore.getItemAsync(STORAGE_KEY))

export const saveTarget = (target: PairingTarget) => SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(target))

export const clearTarget = () => SecureStore.deleteItemAsync(STORAGE_KEY)
