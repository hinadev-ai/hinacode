import { lazy, Suspense } from "react"
import { useImageEditor } from "../../stores/imageEditor.ts"

const ImageEditor = lazy(() => import("./ImageEditor.tsx").then((module) => ({ default: module.ImageEditor })))

export function ImageEditorHost() {
  const request = useImageEditor((state) => state.request)
  if (request === null) return null
  return (
    <Suspense fallback={null}>
      <ImageEditor key={request.attachment.id} request={request} />
    </Suspense>
  )
}
