import type { Artifact } from "@shared/artifact.ts"
import { Directory, File, Paths } from "expo-file-system"
import { call } from "./connection"

export type StagedPage = { readonly directory: string; readonly entry: string }

const BASE64_PREFIX = /^data:[^,]*;base64,/

let stagings = 0

const fileIn = (directory: Directory, path: string) => new File(directory, ...path.split("/"))

const download = async (artifact: Artifact, server: string | undefined, into: Directory) => {
  const written = await Promise.allSettled(
    artifact.files.map(async ({ path }) => {
      const { dataUrl } = await call("artifacts.file", { id: artifact.id, path }, { server })
      const file = fileIn(into, path)
      file.parentDirectory.create({ intermediates: true, idempotent: true })
      await file.write(dataUrl.replace(BASE64_PREFIX, ""), { encoding: "base64" })
    }),
  )
  const failed = written.find((result) => result.status === "rejected")
  if (failed !== undefined) throw failed.reason
}

const versionOf = (directory: Directory) => /^v(\d+)$/.exec(directory.name)?.[1]

export async function stagePage(artifact: Artifact, server: string | undefined): Promise<StagedPage> {
  const home = new Directory(Paths.cache, "artifact-pages", artifact.id)
  const ready = new Directory(home, `v${artifact.version}`)
  if (!ready.exists) {
    const staging = new Directory(home, `.staging-${stagings++}`)
    if (staging.exists) staging.delete()
    staging.create({ intermediates: true })
    try {
      await download(artifact, server, staging)
    } catch (cause) {
      if (staging.exists) staging.delete()
      throw cause
    }
    if (ready.exists) staging.delete()
    else staging.moveSync(ready)
  }
  for (const entry of home.list()) {
    const version = entry instanceof Directory ? versionOf(entry) : undefined
    if (version !== undefined && Number(version) < artifact.version) entry.delete()
  }
  const directory = ready.uri.endsWith("/") ? ready.uri : `${ready.uri}/`
  return { directory, entry: fileIn(ready, artifact.entry).uri }
}
