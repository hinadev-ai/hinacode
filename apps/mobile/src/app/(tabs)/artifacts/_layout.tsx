import { TabStack } from "@/components/tab-stack"
import { copy } from "@/lib/copy"

export default function ArtifactsLayout() {
  return <TabStack title={copy("mobile_artifacts_title")} />
}
