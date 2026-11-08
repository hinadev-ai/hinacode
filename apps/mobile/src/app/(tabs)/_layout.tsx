import { NativeTabs } from "expo-router/native-tabs"
import { useState } from "react"
import { isIOS, liquidGlass } from "@/components/glass"
import { NewThreadAccessory } from "@/components/new-thread-accessory"
import { NewThreadSheet } from "@/components/new-thread-sheet"
import { useTheme } from "@/hooks/use-theme"
import { copy } from "@/lib/copy"

/**
 * Threads, Pull requests, Settings and Search. iOS 26 draws the glass tab bar, the search tab and Start a new thread
 * as the bottom accessory; elsewhere the Threads tab floats its own accessory.
 */
export default function TabsLayout() {
  const theme = useTheme()
  const [newThreadOpen, setNewThreadOpen] = useState(false)
  return (
    <>
      <NativeTabs
        tintColor={theme.primary}
        backgroundColor={isIOS ? undefined : theme.background}
        indicatorColor={theme.surface}
      >
        {liquidGlass && (
          <NativeTabs.BottomAccessory>
            <NewThreadAccessory onPress={() => setNewThreadOpen(true)} />
          </NativeTabs.BottomAccessory>
        )}
        <NativeTabs.Trigger name="(threads)" testID="threads-tab">
          <NativeTabs.Trigger.Label>{copy("mobile_home_title")}</NativeTabs.Trigger.Label>
          <NativeTabs.Trigger.Icon sf="bubble.left.and.bubble.right" md="forum" />
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="pull-requests" testID="pull-requests-tab">
          <NativeTabs.Trigger.Label>{copy("mobile_overview_pull_requests")}</NativeTabs.Trigger.Label>
          <NativeTabs.Trigger.Icon sf="arrow.triangle.pull" md="merge" />
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="settings" testID="settings-tab">
          <NativeTabs.Trigger.Label>{copy("mobile_settings_title")}</NativeTabs.Trigger.Label>
          <NativeTabs.Trigger.Icon sf="gearshape" md="settings" />
        </NativeTabs.Trigger>
        <NativeTabs.Trigger name="search" role="search" testID="search-tab">
          <NativeTabs.Trigger.Label>{copy("mobile_search_title")}</NativeTabs.Trigger.Label>
          <NativeTabs.Trigger.Icon sf="magnifyingglass" md="search" />
        </NativeTabs.Trigger>
      </NativeTabs>
      {liquidGlass && <NewThreadSheet open={newThreadOpen} onClose={() => setNewThreadOpen(false)} />}
    </>
  )
}
