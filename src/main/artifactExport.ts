import { randomUUID } from "node:crypto"
import { rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { app, type BrowserWindow, dialog, net } from "electron"
import { artifactUrl } from "../shared/channels.ts"
import type { ArtifactExportRequest } from "../shared/artifact.ts"
import { injectArtifactTheme, parseArtifactTheme } from "../shared/artifactTheme.ts"
import { documentPrintHtml } from "../shared/documentPrint.ts"
import { withArtifactPage } from "./artifactPage.ts"

type ExportFormat = ArtifactExportRequest["format"]

const formats: Record<ExportFormat, { readonly extension: string; readonly name: string }> = {
  html: { extension: "html", name: "HTML" },
  pdf: { extension: "pdf", name: "PDF" },
  "document-pdf": { extension: "pdf", name: "PDF" },
  "document-markdown": { extension: "md", name: "Markdown" },
}

export const exportFileName = (title: string, format: ExportFormat) =>
  `${title.replace(/[\\/:*?"<>|\p{Cc}]+/gu, " ").trim() || "Artifact"}.${formats[format].extension}`

const fetchText = async (url: string) => {
  const response = await net.fetch(url)
  if (!response.ok) throw new Error(`The artifact answered ${response.status}.`)
  return response.text()
}

const renderPdf = (url: string) => withArtifactPage({ url }, (page) => page.printToPDF({ printBackground: true }))

const printedDocument = (title: string, body: string, theme: string) => {
  const page = documentPrintHtml(title, body)
  const parsed = parseArtifactTheme(theme)
  return parsed === undefined ? page : injectArtifactTheme(page, parsed)
}

const renderDocumentPdf = async (title: string, body: string, theme: string) => {
  const file = join(app.getPath("temp"), `hinacode-print-${randomUUID()}.html`)
  await writeFile(file, printedDocument(title, body, theme))
  try {
    return await renderPdf(pathToFileURL(file).href)
  } finally {
    await rm(file, { force: true })
  }
}

const render = (request: ArtifactExportRequest) => {
  if ("body" in request)
    return request.format === "document-pdf"
      ? renderDocumentPdf(request.title, request.body, request.theme)
      : request.body
  const url = `${artifactUrl(request.id, request.entry)}?theme=${encodeURIComponent(request.theme)}`
  return request.format === "pdf" ? renderPdf(url) : fetchText(url)
}

export const exportArtifact = async (window: BrowserWindow | null, request: ArtifactExportRequest) => {
  const format = formats[request.format]
  const options: Electron.SaveDialogOptions = {
    defaultPath: join(app.getPath("downloads"), exportFileName(request.title, request.format)),
    filters: [{ name: format.name, extensions: [format.extension] }],
  }
  const target = await (window ? dialog.showSaveDialog(window, options) : dialog.showSaveDialog(options))
  if (target.canceled || target.filePath === undefined) return null
  await writeFile(target.filePath, await render(request))
  return target.filePath
}
