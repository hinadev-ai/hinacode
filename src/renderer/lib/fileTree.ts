export interface FileTreeFolder<F> {
  readonly name: string
  readonly path: string
  readonly folders: ReadonlyArray<FileTreeFolder<F>>
  readonly files: ReadonlyArray<F>
}

interface MutableFolder<F> {
  readonly folders: Map<string, MutableFolder<F>>
  readonly files: Array<F>
}

const freeze = <F>(name: string, path: string, folder: MutableFolder<F>): FileTreeFolder<F> => {
  const [only] = folder.folders
  if (only !== undefined && folder.folders.size === 1 && folder.files.length === 0 && name !== "") {
    const [childName, child] = only
    return freeze(`${name}/${childName}`, `${path}${childName}/`, child)
  }
  return {
    name,
    path,
    folders: [...folder.folders].map(([childName, child]) => freeze(childName, `${path}${childName}/`, child)),
    files: folder.files,
  }
}

export const fileTree = <F extends { readonly path: string }>(files: ReadonlyArray<F>): FileTreeFolder<F> => {
  const root: MutableFolder<F> = { folders: new Map(), files: [] }
  for (const file of files) {
    let folder = root
    for (const part of file.path.split("/").slice(0, -1)) {
      let child = folder.folders.get(part)
      if (child === undefined) {
        child = { folders: new Map(), files: [] }
        folder.folders.set(part, child)
      }
      folder = child
    }
    folder.files.push(file)
  }
  return freeze("", "", root)
}
