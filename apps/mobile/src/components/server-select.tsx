import { useState } from "react"
import { Pressable, StyleSheet, Text, View } from "react-native"
import { GroupedCard } from "@/components/grouped-card"
import { Icon } from "@/components/icon"
import { OptionRow, Sheet } from "@/components/sheet"
import { radius } from "@/constants/theme"
import { serverName } from "@/hooks/use-server"
import { useTheme } from "@/hooks/use-theme"
import type { Server } from "@/lib/connection"
import { copy } from "@/lib/copy"
import { useThreads } from "@/stores/threads"

export function ServerSelect({
  testID,
  label,
  servers,
  value,
  onlyConnected = false,
  onChange,
}: {
  testID: string
  label: string
  servers: readonly Server[]
  value: Server
  onlyConnected?: boolean
  onChange: (id: string) => void
}) {
  const theme = useTheme()
  const projects = useThreads((state) => state.projects)
  const [open, setOpen] = useState(false)
  const statusColor = (server: Server) => (server.status === "connected" ? theme.running : theme.textMuted)
  return (
    <>
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityValue={{ text: serverName(value) }}
        onPress={() => setOpen(true)}
        style={({ pressed }) => [
          styles.select,
          { backgroundColor: pressed ? theme.surfaceStrong : theme.surface, borderColor: theme.border },
        ]}
      >
        <View style={[styles.dot, { backgroundColor: statusColor(value) }]} />
        <Text numberOfLines={1} style={[styles.selectText, { color: theme.text }]}>
          {serverName(value)}
        </Text>
        <Icon name="ChevronDown" size={16} color={theme.textMuted} />
      </Pressable>
      <Sheet title={label} open={open} onClose={() => setOpen(false)} fit>
        <View role="radiogroup">
          <GroupedCard inset={16}>
            {servers.map((server) => (
              <OptionRow
                key={server.id}
                label={serverName(server)}
                hint={copy("mobile_new_thread_environment_projects", {
                  count: String(projects.filter((project) => project.environmentId === server.id).length),
                })}
                icon={server.status === "connected" ? "Computer" : "CloudOff"}
                selected={server.id === value.id}
                disabled={onlyConnected && server.status !== "connected"}
                onPress={() => {
                  onChange(server.id)
                  setOpen(false)
                }}
              />
            ))}
          </GroupedCard>
        </View>
      </Sheet>
    </>
  )
}

const styles = StyleSheet.create({
  select: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    paddingHorizontal: 12,
  },
  selectText: { flex: 1, fontSize: 16 },
  dot: { width: 8, height: 8, borderRadius: radius.full },
})
