import type { ArtifactKind } from "@shared/artifact.ts"
import { router } from "expo-router"
import type { IconName } from "@/components/icon"
import { copy } from "./copy"

type KindInfo = {
  readonly label: string
  readonly untitled: string
  readonly icon: IconName
  readonly viewer: "/thread/[id]/document" | "/thread/[id]/artifact"
}

export const artifactKinds: Record<ArtifactKind, KindInfo> = {
  page: {
    label: copy("mobile_artifact_card_page"),
    untitled: copy("mobile_artifact_untitled_page"),
    icon: "Layout",
    viewer: "/thread/[id]/artifact",
  },
  document: {
    label: copy("mobile_artifact_card_document"),
    untitled: copy("mobile_artifact_untitled_document"),
    icon: "FileText",
    viewer: "/thread/[id]/document",
  },
  whiteboard: {
    label: copy("mobile_artifacts_whiteboard"),
    untitled: copy("mobile_artifact_untitled_whiteboard"),
    icon: "Flow",
    viewer: "/thread/[id]/artifact",
  },
}

export const openArtifact = (
  threadId: string,
  artifact: { readonly id: string; readonly kind: ArtifactKind; readonly title: string },
) =>
  router.push({
    pathname: artifactKinds[artifact.kind].viewer,
    params: { id: threadId, artifactId: artifact.id, title: artifact.title },
  })
