import type { PairingTarget } from "@shared/remote.ts"
import { parsePreferences, PREFERENCES_KEY, type Preferences } from "./preferences"
import { parseStoredTarget, STORAGE_KEY } from "./stored-target"

export const loadTarget = async () => parseStoredTarget(localStorage.getItem(STORAGE_KEY))

export const saveTarget = async (target: PairingTarget) => localStorage.setItem(STORAGE_KEY, JSON.stringify(target))

export const clearTarget = async () => localStorage.removeItem(STORAGE_KEY)

export const loadPreferences = async () => parsePreferences(localStorage.getItem(PREFERENCES_KEY))

export const savePreferences = async (preferences: Preferences) =>
  localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences))
