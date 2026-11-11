import { NativeTabs } from "expo-router/native-tabs"
import { isIOS } from "@/components/glass"
import { useSideRail } from "@/hooks/use-side-rail"
import { useTheme } from "@/hooks/use-theme"
import { copy } from "@/lib/copy"

const tabIcons = {
  threads: require("../../../assets/images/tabs/threads.png"),
  pullRequests: require("../../../assets/images/tabs/pull-requests.png"),
  artifacts: require("../../../assets/images/tabs/artifacts.png"),
  settings: require("../../../assets/images/tabs/settings.png"),
  search: require("../../../assets/images/tabs/search.png"),
}

export default function TabsLayout() {
  const theme = useTheme()
  const railed = useSideRail() > 0
  return (
    <NativeTabs
      tintColor={theme.primary}
      backgroundColor={isIOS ? undefined : theme.background}
      indicatorColor={theme.surface}
      labelVisibilityMode="labeled"
    >
      <NativeTabs.Trigger name="(threads)" testID="threads-tab">
        <NativeTabs.Trigger.Label>{copy("mobile_home_title")}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon src={tabIcons.threads} renderingMode="template" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="pull-requests" testID="pull-requests-tab">
        <NativeTabs.Trigger.Label>{copy("mobile_overview_pull_requests")}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon src={tabIcons.pullRequests} renderingMode="template" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="artifacts" testID="artifacts-tab">
        <NativeTabs.Trigger.Label>{copy("mobile_artifacts_title")}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon src={tabIcons.artifacts} renderingMode="template" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="settings" testID="settings-tab">
        <NativeTabs.Trigger.Label>{copy("mobile_settings_title")}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon src={tabIcons.settings} renderingMode="template" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="search" role="search" testID="search-tab" hidden={railed}>
        <NativeTabs.Trigger.Label>{copy("mobile_search_title")}</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon src={tabIcons.search} renderingMode="template" />
      </NativeTabs.Trigger>
    </NativeTabs>
  )
}
