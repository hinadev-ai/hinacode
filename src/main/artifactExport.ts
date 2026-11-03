import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { app, type BrowserWindow, dialog, net } from "electron"
import { artifactUrl } from "../shared/channels.ts"
import type { ArtifactExportRequest } from "../shared/artifact.ts"
import { withArtifactPage } from "./artifactPage.ts"

export const exportFileName = (title: string, format: "html" | "pdf") =>
  `${title.replace(/[\\/:*?"<>|\p{Cc}]+/gu, " ").trim() || "Artifact"}.${format}`

const renderHtml = async (url: string) => {
  const response = await net.fetch(url)
  if (!response.ok) throw new Error(`The artifact answered ${response.status}.`)
  return response.text()
}

const renderPdf = (url: string) => withArtifactPage({ url }, (page) => page.printToPDF({ printBackground: true }))

export const exportArtifact = async (window: BrowserWindow | null, request: ArtifactExportRequest) => {
  const options: Electron.SaveDialogOptions = {
    defaultPath: join(app.getPath("downloads"), exportFileName(request.title, request.format)),
    filters: [request.format === "pdf" ? { name: "PDF", extensions: ["pdf"] } : { name: "HTML", extensions: ["html"] }],
  }
  const target = await (window ? dialog.showSaveDialog(window, options) : dialog.showSaveDialog(options))
  if (target.canceled || target.filePath === undefined) return null
  const url = `${artifactUrl(request.id, request.entry)}?theme=${encodeURIComponent(request.theme)}`
  await writeFile(target.filePath, request.format === "pdf" ? await renderPdf(url) : await renderHtml(url))
  return target.filePath
}
