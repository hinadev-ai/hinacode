import { app, nativeImage, type WebContents } from "electron"

const ICON_SIZE = 128

const dragIcon = async (path: string) => {
  const image = nativeImage.createFromPath(path)
  if (image.isEmpty()) return app.getFileIcon(path)
  const { width, height } = image.getSize()
  return image.resize(width >= height ? { width: ICON_SIZE } : { height: ICON_SIZE })
}

export const startFileDrag = async (sender: WebContents, path: string) => {
  sender.startDrag({ file: path, icon: await dragIcon(path) })
}
