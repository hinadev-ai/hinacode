import { TabStack } from "@/components/tab-stack"
import { copy } from "@/lib/copy"

export default function PullRequestsLayout() {
  return <TabStack title={copy("mobile_overview_pull_requests")} />
}
