import { TabStack } from "@/components/tab-stack"
import { copy } from "@/lib/copy"

export default function ThreadsLayout() {
  return <TabStack title={copy("mobile_home_title")} />
}
