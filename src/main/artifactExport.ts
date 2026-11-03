import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { app, type BrowserWindow, dialog, net } from "electron"
import { artifactUrl } from "../shared/channels.ts"
import type { ArtifactExportRequest } from "../shared/artifact.ts"
import { withArtifactPage } from "./artifactPage.ts"

type ExportFormat = ArtifactExportRequest["format"]

const formats: Record<ExportFormat, { readonly extension: string; readonly name: string }> = {
  html: { extension: "html", name: "HTML" },
  pdf: { extension: "pdf", name: "PDF" },
  markdown: { extension: "md", name: "Markdown" },
}

export const exportFileName = (title: string, format: ExportFormat) =>
  `${title.replace(/[\\/:*?"<>|\p{Cc}]+/gu, " ").trim() || "Artifact"}.${formats[format].extension}`

const fetchText = async (url: string) => {
  const response = await net.fetch(url)
  if (!response.ok) throw new Error(`The artifact answered ${response.status}.`)
  return response.text()
}

const renderPdf = (url: string) => withArtifactPage({ url }, (page) => page.printToPDF({ printBackground: true }))

export const exportArtifact = async (window: BrowserWindow | null, request: ArtifactExportRequest) => {
  const format = formats[request.format]
  const options: Electron.SaveDialogOptions = {
    defaultPath: join(app.getPath("downloads"), exportFileName(request.title, request.format)),
    filters: [{ name: format.name, extensions: [format.extension] }],
  }
  const target = await (window ? dialog.showSaveDialog(window, options) : dialog.showSaveDialog(options))
  if (target.canceled || target.filePath === undefined) return null
  const url = `${artifactUrl(request.id, request.entry)}?theme=${encodeURIComponent(request.theme)}`
  await writeFile(target.filePath, request.format === "pdf" ? await renderPdf(url) : await fetchText(url))
  return target.filePath
}
