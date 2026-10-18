import { useColorScheme } from "react-native"
import { Colors, type Palette } from "@/constants/theme"
import { usePreferences } from "@/stores/preferences"

export type Scheme = "light" | "dark"

/** The phone's appearance setting, or the system's when it is set to follow it. */
export function useScheme(): Scheme {
  const system = useColorScheme()
  const appearance = usePreferences((state) => state.appearance)
  if (appearance !== "system") return appearance
  return system === "dark" ? "dark" : "light"
}

export function useTheme(): Palette {
  return Colors[useScheme()]
}
