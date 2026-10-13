import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router"
import { StatusBar } from "expo-status-bar"
import { useColorScheme } from "react-native"
import { ConnectionProvider } from "@/components/connection-provider"
import { useTheme } from "@/hooks/use-theme"
import { useConnection } from "@/lib/connection"

export default function RootLayout() {
  const scheme = useColorScheme()
  const theme = useTheme()
  const base = scheme === "dark" ? DarkTheme : DefaultTheme
  return (
    <ThemeProvider
      value={{
        ...base,
        colors: {
          ...base.colors,
          primary: theme.primary,
          background: theme.background,
          card: theme.background,
          text: theme.text,
          border: theme.border,
        },
      }}
    >
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />
      <ConnectionProvider>
        <Routes />
      </ConnectionProvider>
    </ThemeProvider>
  )
}

function Routes() {
  const paired = useConnection((state) => state.target !== null && state.status !== "unauthorized")
  return (
    <Stack screenOptions={{ headerShadowVisible: false }}>
      <Stack.Protected guard={paired}>
        <Stack.Screen name="index" options={{ title: "Threads" }} />
        <Stack.Screen name="thread/[id]" options={{ title: "" }} />
      </Stack.Protected>
      <Stack.Protected guard={!paired}>
        <Stack.Screen name="connect" options={{ title: "Pair with desktop" }} />
      </Stack.Protected>
    </Stack>
  )
}
