import {
  fileExtensions as catppuccinExtensions,
  fileNames as catppuccinNames,
} from "catppuccin-vsc-icons/src/defaults/fileIcons.ts"

const iconsByName: Readonly<Record<string, string>> = catppuccinNames
const iconsByExtension: Readonly<Record<string, string>> = catppuccinExtensions

const ICON_DIRECTORY = "../../../node_modules/catppuccin-vsc-icons/icons/css-variables/"

const svgs = import.meta.glob<string>("../../../node_modules/catppuccin-vsc-icons/icons/css-variables/*.svg", {
  query: "?raw",
  import: "default",
  eager: true,
})

const extensionsOf = (name: string) =>
  [...name.matchAll(/\./g)].map((dot) => name.slice(dot.index + 1)).filter((extension) => extension !== "")

export const fileIconName = (path: string): string => {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase()
  const byName = iconsByName[name]
  if (byName) return byName
  for (const extension of extensionsOf(name)) {
    const byExtension = iconsByExtension[extension]
    if (byExtension) return byExtension
  }
  return "_file"
}

export const fileIconSvg = (path: string): string => svgs[`${ICON_DIRECTORY}${fileIconName(path)}.svg`] ?? ""
