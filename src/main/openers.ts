import { execFile, spawn } from "node:child_process"
import { access } from "node:fs/promises"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"
import { nativeImage } from "electron"
import { Effect, Schema } from "effect"
import type { Opener, OpenerId } from "../shared/domain.ts"

interface Launcher {
  readonly name: string
  /** The bundle name on macOS, or null when the app has no macOS build. */
  readonly bundle: string | null
  /** The command the app installs on Linux and Windows, or null when it has none there. */
  readonly cli: string | null
  readonly opensFiles: boolean
}

const launchers: Record<OpenerId, Launcher> = {
  vscode: { name: "VS Code", bundle: "Visual Studio Code.app", cli: "code", opensFiles: true },
  cursor: { name: "Cursor", bundle: "Cursor.app", cli: "cursor", opensFiles: true },
  windsurf: { name: "Windsurf", bundle: "Windsurf.app", cli: "windsurf", opensFiles: true },
  zed: { name: "Zed", bundle: "Zed.app", cli: "zed", opensFiles: true },
  sublime: { name: "Sublime Text", bundle: "Sublime Text.app", cli: "subl", opensFiles: true },
  xcode: { name: "Xcode", bundle: "Xcode.app", cli: null, opensFiles: true },
  terminal: { name: "Terminal", bundle: "Utilities/Terminal.app", cli: null, opensFiles: false },
  iterm: { name: "iTerm", bundle: "iTerm.app", cli: null, opensFiles: false },
  ghostty: { name: "Ghostty", bundle: "Ghostty.app", cli: null, opensFiles: false },
  warp: { name: "Warp", bundle: "Warp.app", cli: null, opensFiles: false },
}

export class OpenerError extends Schema.TaggedError<OpenerError>()("OpenerError", { message: Schema.String }) {}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  )

const firstExisting = async (paths: ReadonlyArray<string>) => {
  for (const path of paths) if (await exists(path)) return path
  return null
}

const applicationDirs = ["/Applications", join(homedir(), "Applications"), "/System/Applications"]

const executableNames = (cli: string) => (process.platform === "win32" ? [`${cli}.cmd`, `${cli}.exe`, cli] : [cli])

/** Where the app is installed: its bundle on macOS, its command on PATH elsewhere. */
const locate = (launcher: Launcher): Promise<string | null> => {
  if (process.platform === "darwin") {
    const { bundle } = launcher
    return bundle === null ? Promise.resolve(null) : firstExisting(applicationDirs.map((dir) => join(dir, bundle)))
  }
  const { cli } = launcher
  if (cli === null) return Promise.resolve(null)
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean)
  return firstExisting(dirs.flatMap((dir) => executableNames(cli).map((name) => join(dir, name))))
}

const iconOf = async (location: string) => {
  if (process.platform !== "darwin") return null
  // `app.getFileIcon` answers a generic placeholder for an app bundle. QuickLook draws the app's own icon.
  const icon = await nativeImage.createThumbnailFromPath(location, { width: 64, height: 64 }).catch(() => null)
  return icon === null || icon.isEmpty() ? null : icon.toDataURL()
}

export const listOpeners: Effect.Effect<ReadonlyArray<Opener>> = Effect.promise(async () => {
  const entries = Object.entries(launchers) as Array<[OpenerId, Launcher]>
  const found = await Promise.all(
    entries.map(async ([id, launcher]): Promise<Opener | null> => {
      const location = await locate(launcher)
      if (location === null) return null
      return { id, name: launcher.name, opensFiles: launcher.opensFiles, icon: await iconOf(location) }
    }),
  )
  return found.filter((opener) => opener !== null)
})

const launch = (location: string, path: string) =>
  new Promise<void>((resolve, reject) => {
    if (process.platform === "darwin") {
      execFile("open", ["-a", location, path], (error) => (error ? reject(error) : resolve()))
      return
    }
    // The editor outlives this app by design, so it drops the tag the development resource monitor follows.
    const env = { ...process.env, HINACODE_INSTANCE: undefined }
    // A `.cmd` shim only runs through the shell on Windows, which joins the arguments unquoted.
    const child =
      process.platform === "win32"
        ? spawn(`"${location}"`, [`"${path}"`], { detached: true, stdio: "ignore", shell: true, env })
        : spawn(location, [path], { detached: true, stdio: "ignore", env })
    child.once("error", reject)
    child.once("spawn", () => {
      child.unref()
      resolve()
    })
  })

export const openWith = (path: string, id: OpenerId): Effect.Effect<void, OpenerError> =>
  Effect.tryPromise({
    try: async () => {
      const launcher = launchers[id]
      const location = await locate(launcher)
      if (location === null) throw new Error(`${launcher.name} is not installed`)
      await launch(location, path)
    },
    catch: (cause) => new OpenerError({ message: cause instanceof Error ? cause.message : String(cause) }),
  })
