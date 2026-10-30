import { join } from "node:path"
import {
  type BrowserWindow,
  clipboard,
  type ContextMenuParams,
  dialog,
  Menu,
  type MenuItemConstructorOptions,
  nativeImage,
  shell,
} from "electron"
import { Effect, type ManagedRuntime } from "effect"
import type { Locale, Opener } from "../shared/domain.ts"
import * as m from "../renderer/paraglide/messages.js"
import { listOpeners, openWith } from "./openers.ts"
import { attachmentRequest, externalUrl, githubAssetId, projectFileRequest } from "./security.ts"
import { ClientSettings } from "./services/ClientSettings.ts"
import { Environments } from "./services/Environments.ts"

type MenuRuntime = ManagedRuntime.ManagedRuntime<ClientSettings | Environments, unknown>

type ImageOrigin =
  | { readonly kind: "file"; readonly path: string; readonly local: boolean }
  | { readonly kind: "web"; readonly address: string }

const imageOrigin = (src: string, cloudOfRoot: (root: string) => string | undefined): ImageOrigin => {
  const project = projectFileRequest(src)
  if (project !== null)
    return { kind: "file", path: join(project.root, project.path), local: cloudOfRoot(project.root) === undefined }
  const attachment = attachmentRequest(src)
  if (attachment !== null) return { kind: "file", path: attachment.path, local: attachment.environment === null }
  const asset = githubAssetId(src)
  return { kind: "web", address: asset === null ? src : `https://github.com/user-attachments/assets/${asset}` }
}

const openerIcon = (opener: Opener) =>
  opener.icon === null ? undefined : nativeImage.createFromDataURL(opener.icon).resize({ width: 16, height: 16 })

interface MenuContext {
  readonly window: BrowserWindow
  readonly params: ContextMenuParams
  readonly locale: Locale
  readonly appUrl: string
  readonly image: ImageOrigin | null
  readonly openers: ReadonlyArray<Opener>
  readonly open: (path: string, opener: Opener) => void
}

const linkItems = ({ params, locale, appUrl }: MenuContext): MenuItemConstructorOptions[] => {
  const { linkURL } = params
  if (linkURL === "" || linkURL.startsWith(new URL(".", appUrl).href)) return []
  const web = externalUrl(linkURL)
  return [
    ...(web === null
      ? []
      : [{ label: m.markdown_open_link({}, { locale }), click: () => void shell.openExternal(web) }]),
    { label: m.markdown_copy_link({}, { locale }), click: () => void clipboard.writeText(linkURL) },
  ]
}

const imageItems = ({ window, params, locale, image, openers, open }: MenuContext): MenuItemConstructorOptions[] => {
  if (image === null) return []
  const copy: MenuItemConstructorOptions[] = [
    { label: m.markdown_copy_image({}, { locale }), click: () => window.webContents.copyImageAt(params.x, params.y) },
    image.kind === "file"
      ? { label: m.explorer_copy_path({}, { locale }), click: () => void clipboard.writeText(image.path) }
      : { label: m.markdown_copy_image_address({}, { locale }), click: () => void clipboard.writeText(image.address) },
  ]
  if (image.kind === "web" || !image.local) return copy
  const { path } = image
  const apps: MenuItemConstructorOptions[] = openers.map((opener) => ({
    label: opener.name,
    icon: openerIcon(opener),
    click: () => open(path, opener),
  }))
  return [
    ...copy,
    { type: "separator" },
    {
      label: m.open_with({}, { locale }),
      submenu: [
        ...apps,
        ...(apps.length > 0 ? [{ type: "separator" as const }] : []),
        { label: m.panel_reveal({}, { locale }), click: () => shell.showItemInFolder(path) },
      ],
    },
  ]
}

const textItems = ({ window, params, locale }: MenuContext): MenuItemConstructorOptions[] => {
  const page = window.webContents
  const copy = { label: m.context_menu_copy({}, { locale }), click: () => page.copy() }
  const { isEditable, editFlags, selectionText } = params
  if (isEditable)
    return [
      { label: m.context_menu_cut({}, { locale }), enabled: editFlags.canCut, click: () => page.cut() },
      { ...copy, enabled: editFlags.canCopy },
      { label: m.context_menu_paste({}, { locale }), enabled: editFlags.canPaste, click: () => page.paste() },
      { type: "separator" },
      {
        label: m.context_menu_select_all({}, { locale }),
        enabled: editFlags.canSelectAll,
        click: () => page.selectAll(),
      },
    ]
  return selectionText.trim() === "" ? [] : [copy]
}

const contextMenuTemplate = (context: MenuContext): MenuItemConstructorOptions[] =>
  [linkItems(context), imageItems(context), textItems(context)]
    .filter((section) => section.length > 0)
    .flatMap((section, index) => (index === 0 ? section : [{ type: "separator" as const }, ...section]))

export const handleContextMenu = (window: BrowserWindow, runtime: MenuRuntime, appUrl: string) =>
  window.webContents.on("context-menu", (_event, params) => {
    const show = Effect.gen(function* () {
      const { locale } = yield* (yield* ClientSettings).get
      const environments = yield* Environments
      const image =
        params.mediaType === "image" && params.srcURL !== "" && !params.srcURL.startsWith("data:")
          ? imageOrigin(params.srcURL, (root) => environments.owner("root", root))
          : null
      const openers = image?.kind === "file" && image.local ? yield* listOpeners : []
      const template = contextMenuTemplate({
        window,
        params,
        locale,
        appUrl,
        image,
        openers: openers.filter((opener) => opener.opensFiles),
        open: (path, opener) =>
          void runtime.runPromise(
            openWith(path, opener.id).pipe(
              Effect.andThen(Effect.flatMap(ClientSettings, (settings) => settings.set({ openWith: opener.id }))),
              Effect.catch((error) =>
                Effect.promise(() =>
                  dialog.showMessageBox(window, {
                    type: "error",
                    message: m.open_with_failed({ app: opener.name, message: error.message }, { locale }),
                  }),
                ),
              ),
            ),
          ),
      })
      if (template.length > 0) Menu.buildFromTemplate(template).popup({ window })
    })
    void runtime.runPromise(show).catch((cause: unknown) => console.error("context menu failed", cause))
  })
