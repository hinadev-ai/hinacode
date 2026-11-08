import { FileTextIcon, FlowIcon, LayoutIcon } from "@hinacode/icons"
import type { Artifact } from "../../../shared/artifact.ts"

const icons = {
  page: LayoutIcon,
  document: FileTextIcon,
  whiteboard: FlowIcon,
} satisfies Record<NonNullable<Artifact["kind"]>, typeof LayoutIcon>

export function ArtifactKindIcon({ artifact, className }: { artifact: Artifact; className?: string }) {
  const Icon = icons[artifact.kind ?? "page"]
  return <Icon aria-hidden className={className} />
}
