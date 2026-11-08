import { TabStack } from "@/components/tab-stack"
import { copy } from "@/lib/copy"

export default function SettingsLayout() {
  return <TabStack title={copy("mobile_settings_title")} />
}
