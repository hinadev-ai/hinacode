import { TabStack } from "@/components/tab-stack"
import { copy } from "@/lib/copy"

export default function SearchLayout() {
  return <TabStack title={copy("mobile_search_title")} />
}
