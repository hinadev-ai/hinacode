import type { PairingTarget } from "@shared/remote.ts"
import { parseStoredTarget, STORAGE_KEY } from "./stored-target"

export const loadTarget = async () => parseStoredTarget(localStorage.getItem(STORAGE_KEY))

export const saveTarget = async (target: PairingTarget) => localStorage.setItem(STORAGE_KEY, JSON.stringify(target))

export const clearTarget = async () => localStorage.removeItem(STORAGE_KEY)
