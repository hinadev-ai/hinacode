import { Colors, type Palette } from "@/constants/theme"
import { useColorScheme } from "react-native"

export function useTheme(): Palette {
  return Colors[useColorScheme() === "dark" ? "dark" : "light"]
}
