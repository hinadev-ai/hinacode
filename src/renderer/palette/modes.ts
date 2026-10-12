import { m } from "../paraglide/messages.js"
import { commandsSource, filesSource, projectsSource, threadsSource } from "./sources.tsx"
import type { PaletteGroup, PaletteMode } from "./types.ts"
import { COMMAND_PREFIX } from "./usePalette.ts"

const goTo: PaletteMode = {
  id: "goto",
  prefix: "",
  placeholder: m.palette_placeholder,
  sources: [threadsSource, projectsSource, filesSource],
}

/** Every mode the palette offers. The one with the longest matching prefix wins, so `goTo` catches the rest. */
export const paletteModes: ReadonlyArray<PaletteMode> = [
  { id: "commands", prefix: COMMAND_PREFIX, placeholder: m.palette_commands_placeholder, sources: [commandsSource] },
  goTo,
]

/** The mode the field's text selects, and the text after its prefix. */
export const modeOf = (text: string): { mode: PaletteMode; query: string } => {
  const mode =
    paletteModes
      .filter((candidate) => text.startsWith(candidate.prefix))
      .toSorted((a, b) => b.prefix.length - a.prefix.length)[0] ?? goTo
  return { mode, query: text.slice(mode.prefix.length).trim() }
}

export const groupLabels: Record<PaletteGroup, () => string> = {
  threads: m.palette_group_threads,
  projects: m.palette_group_projects,
  files: m.palette_group_files,
  commands: m.palette_group_commands,
}
