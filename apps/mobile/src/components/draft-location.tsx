import type { Project, Thread } from "@shared/domain.ts"
import { router } from "expo-router"
import { useState } from "react"
import { Pressable, StyleSheet, Text, View } from "react-native"
import { Icon } from "@/components/icon"
import { OptionRow, Section, Sheet } from "@/components/sheet"
import { HIT, radius } from "@/constants/theme"
import { serverName, useThreadServer } from "@/hooks/use-server"
import { useTheme } from "@/hooks/use-theme"
import { useConnection } from "@/lib/connection"
import { copy } from "@/lib/copy"
import { errorText } from "@/lib/error-text"
import { projectsByActivity } from "@/lib/projects"
import { createThread } from "@/lib/start-thread"
import { useDrafts } from "@/stores/drafts"
import { listedThreads, useThreads } from "@/stores/threads"

const CHIP_HEIGHT = 32

export function LocationChip({ thread, onError }: { thread: Thread; onError: (message: string) => void }) {
  const theme = useTheme()
  const [open, setOpen] = useState(false)
  const server = useThreadServer(thread.id)
  const project = useThreads((state) => state.projects.find((candidate) => candidate.id === thread.projectId))
  const label = [server && serverName(server), project?.name].filter(Boolean).join(" / ")
  return (
    <>
      <Pressable
        testID="composer-location"
        accessibilityRole="button"
        accessibilityLabel={copy("mobile_new_thread_environment")}
        accessibilityValue={{ text: label }}
        onPress={() => setOpen(true)}
        hitSlop={{ top: (HIT - CHIP_HEIGHT) / 2, bottom: (HIT - CHIP_HEIGHT) / 2 }}
        style={({ pressed }) => [styles.chip, pressed && { backgroundColor: theme.surfaceStrong }]}
      >
        <View style={[styles.dot, { backgroundColor: server?.status === "connected" ? theme.running : theme.textMuted }]} />
        <Text numberOfLines={1} style={[styles.chipLabel, { color: theme.text }]}>
          {label}
        </Text>
        <Icon name="ChevronDown" size={12} color={theme.textMuted} />
      </Pressable>
      {open && (
        <LocationSheet
          thread={thread}
          serverId={server?.id}
          onClose={() => setOpen(false)}
          onError={onError}
        />
      )}
    </>
  )
}

const moveDraftTo = async (project: Project, thread: Thread) => {
  const next = await createThread(project)
  const drafts = useDrafts.getState()
  const text = drafts.byThreadId[thread.id] ?? ""
  if (text !== "") {
    drafts.setText(next.id, text)
    drafts.setText(thread.id, "")
  }
  return next
}

function LocationSheet({
  thread,
  serverId,
  onClose,
  onError,
}: {
  thread: Thread
  serverId: string | undefined
  onClose: () => void
  onError: (message: string) => void
}) {
  const servers = useConnection((state) => state.servers)
  const projects = useThreads((state) => state.projects)
  const byId = useThreads((state) => state.byId)
  const [browsing, setBrowsing] = useState(serverId)
  const [moving, setMoving] = useState(false)
  const shown = projectsByActivity(projects, listedThreads(byId)).filter((item) => item.environmentId === browsing)

  const move = async (project: Project) => {
    if (project.id === thread.projectId) return onClose()
    setMoving(true)
    try {
      const next = await moveDraftTo(project, thread)
      onClose()
      router.replace({ pathname: "/thread/[id]", params: { id: next.id } })
    } catch (cause) {
      onError(errorText(cause))
      setMoving(false)
    }
  }

  return (
    <Sheet title={copy("mobile_new_thread_environment")} open onClose={onClose}>
      <Section title={copy("mobile_new_thread_environment")}>
        {servers.map((server) => (
          <OptionRow
            key={server.id}
            label={serverName(server)}
            icon={server.status === "connected" ? "Computer" : "CloudOff"}
            selected={server.id === browsing}
            disabled={server.status !== "connected" || moving}
            onPress={() => setBrowsing(server.id)}
          />
        ))}
      </Section>
      {shown.length > 0 && (
        <Section title={copy("mobile_new_thread_project")}>
          {shown.map((project) => (
            <OptionRow
              key={project.id}
              label={project.name}
              icon="Folder"
              selected={project.id === thread.projectId}
              disabled={moving}
              onPress={() => void move(project)}
            />
          ))}
        </Section>
      )}
    </Sheet>
  )
}

const styles = StyleSheet.create({
  chip: {
    height: CHIP_HEIGHT,
    flexShrink: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 8,
    borderRadius: radius.full,
  },
  dot: { width: 7, height: 7, borderRadius: radius.full },
  chipLabel: { flexShrink: 1, fontSize: 12 },
})
