import type {
  GuideCategory,
  GuideFileNote,
  GuideGroup,
  GuideLineNote,
  PullRequestFile,
  PullRequestGuide,
} from "../../shared/domain.ts"

export interface GuideFile {
  readonly file: PullRequestFile
  readonly fileNotes: ReadonlyArray<GuideFileNote>
  /** Notes on lines the diff shows. */
  readonly lineNotes: ReadonlyArray<GuideLineNote>
  /** Notes on lines outside every hunk, which the diff cannot show. */
  readonly strayLineNotes: ReadonlyArray<GuideLineNote>
}

export interface ResolvedGroup {
  /** The model's key, suffixed when it repeats one, so it is unique within the guide. */
  readonly key: string
  readonly label: string
  readonly summary: string | undefined
  readonly category: GuideCategory
  /** The group, one of its notes or one of its children asks for extra care. */
  readonly critical: boolean
  readonly files: ReadonlyArray<GuideFile>
  readonly children: ReadonlyArray<ResolvedGroup>
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm

/** Whether a hunk of `patch` shows the line, numbered in the new file for additions and the old one for deletions. */
const shows = (patch: string, { side, line }: GuideLineNote) =>
  [...patch.matchAll(HUNK_HEADER)].some(([, oldStart, oldLines, newStart, newLines]) => {
    const [start, count] = side === "additions" ? [newStart, newLines] : [oldStart, oldLines]
    const first = Number(start)
    return line >= first && line < first + Number(count ?? 1)
  })

/**
 * Matches a guide to the pull request's files as they are now. The guide may describe an older head, so a path
 * that left the diff is dropped, a path named twice stays in its first group, and a file no group names ends up
 * in `others`.
 */
export const resolveGuide = (guide: PullRequestGuide, files: ReadonlyArray<PullRequestFile>) => {
  const byPath = new Map<string, PullRequestFile>()
  for (const file of files) {
    if (file.previousPath !== null) byPath.set(file.previousPath, file)
  }
  for (const file of files) byPath.set(file.path, file)
  const placed = new Set<string>()
  const keys = new Set<string>()
  const uniqueKey = (key: string) => {
    let unique = key
    for (let count = 2; keys.has(unique); count++) unique = `${key}-${count}`
    keys.add(unique)
    return unique
  }

  const resolveFiles = (group: GuideGroup) =>
    group.filePaths.flatMap((path): Array<GuideFile> => {
      const file = byPath.get(path)
      if (file === undefined || placed.has(file.path)) return []
      placed.add(file.path)
      const owns = (note: { readonly path: string }) => note.path === path || note.path === file.path
      const lineNotes = (group.lineNotes ?? []).filter(owns)
      return [
        {
          file,
          fileNotes: (group.fileNotes ?? []).filter(owns),
          lineNotes: lineNotes.filter((note) => shows(file.patch, note)),
          strayLineNotes: lineNotes.filter((note) => !shows(file.patch, note)),
        },
      ]
    })

  const resolveGroup = (group: GuideGroup): ResolvedGroup | null => {
    const key = uniqueKey(group.key)
    const own = resolveFiles(group)
    const children = (group.children ?? []).flatMap((child) => {
      const resolved = resolveGroup(child)
      return resolved === null ? [] : [resolved]
    })
    if (own.length === 0 && children.length === 0) return null
    const notes = own.flatMap((entry) => [...entry.fileNotes, ...entry.lineNotes, ...entry.strayLineNotes])
    return {
      key,
      label: group.label,
      summary: group.summary,
      category: group.category,
      critical:
        group.critical === true ||
        notes.some((note) => note.critical === true) ||
        children.some((child) => child.critical),
      files: own,
      children,
    }
  }

  const groups = guide.groups.flatMap((group) => {
    const resolved = resolveGroup(group)
    return resolved === null ? [] : [resolved]
  })
  const others = files
    .filter((file) => !placed.has(file.path))
    .map((file): GuideFile => ({ file, fileNotes: [], lineNotes: [], strayLineNotes: [] }))
  return { groups, others }
}

/** Every file of the group and of its children. */
export const groupFiles = (group: ResolvedGroup): ReadonlyArray<GuideFile> => [
  ...group.files,
  ...group.children.flatMap(groupFiles),
]

/** One annotation per line, holding every note on it: the diff renders a single slot per annotated line. */
export const noteAnnotations = (notes: ReadonlyArray<GuideLineNote>) => {
  const byLine = new Map<string, Array<GuideLineNote>>()
  for (const note of notes) {
    const key = `${note.side}:${note.line}`
    byLine.set(key, [...(byLine.get(key) ?? []), note])
  }
  return [...byLine.values()].map((onLine) => ({
    side: onLine[0]?.side ?? "additions",
    lineNumber: onLine[0]?.line ?? 0,
    metadata: onLine as ReadonlyArray<GuideLineNote>,
  }))
}
