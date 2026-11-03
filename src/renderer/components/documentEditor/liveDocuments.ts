export type LiveDocument = { readonly html: () => string; readonly markdown: () => string }

const live = new Map<string, LiveDocument>()

export const liveDocumentKey = (environment: string | null | undefined, id: string) =>
  JSON.stringify([environment ?? null, id])

export const showLiveDocument = (key: string, document: LiveDocument) => {
  live.set(key, document)
  return () => {
    if (live.get(key) === document) live.delete(key)
  }
}

export const liveDocument = (key: string) => live.get(key)

export const printableHtml = (editor: Element) => {
  const copy = editor.cloneNode(true) as Element
  const copies = copy.querySelectorAll<HTMLInputElement>("input[type=checkbox]")
  editor.querySelectorAll<HTMLInputElement>("input[type=checkbox]").forEach((box, index) => {
    copies[index]?.toggleAttribute("checked", box.checked)
  })
  return copy.innerHTML
}
